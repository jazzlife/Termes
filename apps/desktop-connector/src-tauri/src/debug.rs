use crate::model::PlatformCommandResult;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
use std::path::Path;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Pid, System};
use tungstenite::client::client_with_config;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};
use url::{Host, Url};

const MAX_DEBUG_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_COMMAND_RESULT_BYTES: usize = 220 * 1024;
const MAX_CDP_EVENT_BYTES: usize = 128 * 1024;
const MAX_CDP_HTTP_BYTES: usize = 512 * 1024;
const MAX_CDP_MESSAGE_BYTES: usize = 256 * 1024;
const DEBUG_TIMEOUT: Duration = Duration::from_secs(20);

fn completed(value: Value) -> PlatformCommandResult {
    let serialized = serde_json::to_string_pretty(&value).unwrap_or_default();
    let stdout = if serialized.len() <= MAX_COMMAND_RESULT_BYTES {
        serialized
    } else {
        let preview = String::from_utf8_lossy(&serialized.as_bytes()[..64 * 1024]);
        serde_json::to_string_pretty(&json!({
            "truncated": true,
            "originalBytes": serialized.len(),
            "preview": preview,
        }))
        .unwrap_or_else(|_| "{\"truncated\":true}".to_owned())
    };
    PlatformCommandResult {
        status: "completed".to_owned(),
        stdout,
        stderr: String::new(),
        exit_code: Some(0),
        artifact: None,
    }
}

fn failed(message: impl Into<String>) -> PlatformCommandResult {
    PlatformCommandResult {
        status: "failed".to_owned(),
        stdout: String::new(),
        stderr: message.into(),
        exit_code: Some(1),
        artifact: None,
    }
}

fn required_pid(params: &Value) -> Result<u32, String> {
    let raw = params
        .get("pid")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Missing required numeric parameter: pid".to_owned())?;
    let pid = u32::try_from(raw).map_err(|_| "Process id is out of range".to_owned())?;
    if pid == 0 || pid == std::process::id() {
        return Err("The connector cannot target itself or pid 0".to_owned());
    }
    Ok(pid)
}

fn validate_process_identity(params: &Value, pid: u32) -> Result<(), String> {
    let expected_executable = params
        .get("expectedExecutable")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 4_096 && !value.contains('\0'))
        .ok_or_else(|| "Missing or invalid required parameter: expectedExecutable".to_owned())?;
    let expected_start_time = params
        .get("expectedStartTimeUnixSeconds")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            "Missing or invalid required parameter: expectedStartTimeUnixSeconds".to_owned()
        })?;
    let expected_user_id = params
        .get("expectedUserId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256 && !value.contains('\0'))
        .ok_or_else(|| "Missing or invalid required parameter: expectedUserId".to_owned())?;
    let mut system = System::new_all();
    system.refresh_all();
    let process = system
        .process(Pid::from_u32(pid))
        .ok_or_else(|| format!("Debugger target process {pid} was not found"))?;
    let actual_executable = process
        .exe()
        .and_then(Path::to_str)
        .ok_or_else(|| format!("Debugger target process {pid} has no stable executable path"))?;
    #[cfg(target_os = "windows")]
    let executable_matches = actual_executable.eq_ignore_ascii_case(expected_executable);
    #[cfg(not(target_os = "windows"))]
    let executable_matches = actual_executable == expected_executable;
    let actual_user_id = process
        .user_id()
        .map(|value| format!("{value:?}"))
        .ok_or_else(|| format!("Debugger target process {pid} has no stable owner"))?;
    if !executable_matches
        || process.start_time() != expected_start_time
        || actual_user_id != expected_user_id
    {
        return Err("Debugger target identity changed after process selection".to_owned());
    }
    Ok(())
}

fn read_bounded(mut stream: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = stream
        .by_ref()
        .take((MAX_DEBUG_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes);
    let truncated = bytes.len() > MAX_DEBUG_OUTPUT_BYTES;
    bytes.truncate(MAX_DEBUG_OUTPUT_BYTES);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        text.push_str("\n[debug output truncated by Termes Connector]");
    }
    text
}

fn configure_debugger_process(command: &mut Command) {
    #[cfg(target_os = "macos")]
    {
        command.process_group(0);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = command;
    }
}

fn terminate_debugger_process_tree(child: &mut std::process::Child) {
    #[cfg(target_os = "macos")]
    unsafe {
        let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run_debugger_command(
    command: &mut Command,
    cancelled: &dyn Fn() -> bool,
) -> Result<(String, String), String> {
    configure_debugger_process(command);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot start debugger helper: {error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || stdout.map(read_bounded).unwrap_or_default());
    let stderr_reader = thread::spawn(move || stderr.map(read_bounded).unwrap_or_default());
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancelled() => {
                terminate_debugger_process_tree(&mut child);
                return Err("Debugger helper was cancelled by the local emergency stop".to_owned());
            }
            Ok(None) if started.elapsed() < DEBUG_TIMEOUT => {
                thread::sleep(Duration::from_millis(25))
            }
            Ok(None) => {
                terminate_debugger_process_tree(&mut child);
                return Err("Debugger helper timed out".to_owned());
            }
            Err(error) => {
                terminate_debugger_process_tree(&mut child);
                return Err(format!("Cannot wait for debugger helper: {error}"));
            }
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(if stderr.trim().is_empty() {
            format!("Debugger helper exited with {status}")
        } else {
            stderr
        });
    }
    Ok((stdout, stderr))
}

pub fn console(params: &Value, cancelled: &dyn Fn() -> bool) -> PlatformCommandResult {
    let pid = match required_pid(params) {
        Ok(value) => value,
        Err(error) => return failed(error),
    };
    if let Err(error) = validate_process_identity(params, pid) {
        return failed(error);
    }
    #[cfg(target_os = "macos")]
    let result = run_debugger_command(
        Command::new("/usr/bin/sample").args([&pid.to_string(), "1", "1"]),
        cancelled,
    );
    #[cfg(target_os = "windows")]
    let result = match find_windows_console_debugger() {
        Some(path) => run_debugger_command(
            Command::new(path).args(["-p", &pid.to_string(), "-c", "~* kb;qd"]),
            cancelled,
        ),
        None => Err("Windows Console Debugger (cdb.exe) was not found".to_owned()),
    };
    match result {
        Ok((stdout, stderr)) => completed(json!({
            "protocol": if cfg!(target_os = "macos") { "console-stack-sample" } else { "native-console-debugger" },
            "pid": pid,
            "stdout": stdout,
            "stderr": stderr,
        })),
        Err(error) => failed(error),
    }
}

pub fn console_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        Path::new("/usr/bin/sample").is_file()
    }
    #[cfg(target_os = "windows")]
    {
        find_windows_console_debugger().is_some()
    }
}

#[cfg(target_os = "windows")]
fn find_windows_console_debugger() -> Option<PathBuf> {
    let root = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from)?;
    let debugger_root = root.join("Windows Kits/10/Debuggers");
    ["x64/cdb.exe", "arm64/cdb.exe", "x86/cdb.exe"]
        .into_iter()
        .map(|relative| debugger_root.join(relative))
        .find(|path| path.is_file())
}

fn loopback_host(value: Option<&str>) -> Result<&str, String> {
    let host = value.unwrap_or("127.0.0.1");
    if matches!(host, "127.0.0.1" | "::1") {
        Ok(host)
    } else {
        Err("Debugger connections are restricted to this computer".to_owned())
    }
}

fn debugger_port(params: &Value) -> Result<u16, String> {
    let raw = params
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Missing required numeric parameter: port".to_owned())?;
    u16::try_from(raw)
        .ok()
        .filter(|port| *port >= 1024)
        .ok_or_else(|| "Debugger port must be between 1024 and 65535".to_owned())
}

fn validate_loopback_websocket(value: &str, expected_port: u16) -> Result<Url, String> {
    let url = Url::parse(value)
        .map_err(|error| format!("Browser returned an invalid debugger URL: {error}"))?;
    let loopback_host = matches!(
        url.host(),
        Some(Host::Ipv4(address)) if address == Ipv4Addr::LOCALHOST
    ) || matches!(
        url.host(),
        Some(Host::Ipv6(address)) if address == Ipv6Addr::LOCALHOST
    );
    if url.scheme() != "ws"
        || !loopback_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(expected_port)
    {
        return Err("Browser debugger WebSocket must remain on this computer".to_owned());
    }
    Ok(url)
}

fn connect_browser_socket(url: &Url, deadline: Instant) -> Result<WebSocket<TcpStream>, String> {
    let ip = match url.host() {
        Some(Host::Ipv4(address)) if address == Ipv4Addr::LOCALHOST => IpAddr::V4(address),
        Some(Host::Ipv6(address)) if address == Ipv6Addr::LOCALHOST => IpAddr::V6(address),
        _ => return Err("Browser debugger WebSocket is not a literal loopback address".to_owned()),
    };
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Browser debugger WebSocket has no port".to_owned())?;
    let address = SocketAddr::new(ip, port);
    let remaining = deadline.saturating_duration_since(Instant::now());
    let timeout = remaining.min(Duration::from_secs(3));
    if timeout.is_zero() {
        return Err("Browser debugger connection timed out".to_owned());
    }
    let stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("Cannot connect to the browser debugger: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|error| format!("Cannot bound browser debugger reads: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| format!("Cannot bound browser debugger writes: {error}"))?;
    let config = WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .max_message_size(Some(MAX_CDP_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_CDP_MESSAGE_BYTES));
    client_with_config(url.as_str(), stream, Some(config))
        .map(|(socket, _)| socket)
        .map_err(|error| format!("Cannot attach to the browser debugger: {error}"))
}

fn fetch_bounded_json<T: DeserializeOwned>(
    client: &reqwest::blocking::Client,
    url: String,
    label: &str,
) -> Result<T, String> {
    let response = client
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Cannot read {label}: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CDP_HTTP_BYTES as u64)
    {
        return Err(format!("{label} exceeded the 512 KiB response limit"));
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_CDP_HTTP_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read {label}: {error}"))?;
    if bytes.len() > MAX_CDP_HTTP_BYTES {
        return Err(format!("{label} exceeded the 512 KiB response limit"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("{label} returned invalid JSON: {error}"))
}

fn push_cdp_event(events: &mut Vec<Value>, value: Value) {
    let current_bytes = events
        .iter()
        .filter_map(|event| serde_json::to_vec(event).ok())
        .map(|event| event.len())
        .sum::<usize>();
    let value_bytes =
        serde_json::to_vec(&value).map_or(MAX_CDP_EVENT_BYTES + 1, |event| event.len());
    if current_bytes.saturating_add(value_bytes) <= MAX_CDP_EVENT_BYTES {
        events.push(value);
    }
}

fn cdp_request(
    socket: &mut WebSocket<TcpStream>,
    id: u64,
    method: &str,
    params: Value,
    events: &mut Vec<Value>,
    cancelled: &dyn Fn() -> bool,
    deadline: Instant,
) -> Result<Value, String> {
    socket
        .send(Message::Text(
            json!({ "id": id, "method": method, "params": params })
                .to_string()
                .into(),
        ))
        .map_err(|error| format!("Cannot send browser debugger command {method}: {error}"))?;
    loop {
        if cancelled() {
            if method == "Runtime.evaluate" {
                let _ = socket.send(Message::Text(
                    json!({ "id": id.saturating_add(1_000_000), "method": "Runtime.terminateExecution", "params": {} })
                        .to_string()
                        .into(),
                ));
            }
            return Err("Browser debugger was cancelled by the local emergency stop".to_owned());
        }
        if Instant::now() >= deadline {
            if method == "Runtime.evaluate" {
                let _ = socket.send(Message::Text(
                    json!({ "id": id.saturating_add(1_000_000), "method": "Runtime.terminateExecution", "params": {} })
                        .to_string()
                        .into(),
                ));
            }
            return Err(format!("Browser debugger command {method} timed out"));
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let value: Value = serde_json::from_str(text.as_str())
                    .map_err(|error| format!("Browser debugger returned invalid JSON: {error}"))?;
                if value.get("id").and_then(Value::as_u64) == Some(id) {
                    if let Some(error) = value.get("error") {
                        return Err(format!("Browser debugger rejected {method}: {error}"));
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
                if value.get("method").is_some() {
                    push_cdp_event(events, value);
                }
            }
            Ok(Message::Ping(payload)) => {
                let _ = socket.send(Message::Pong(payload));
            }
            Ok(Message::Close(_)) => {
                return Err("Browser debugger closed the connection".to_owned())
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(format!("Cannot read browser debugger response: {error}")),
        }
    }
}

pub fn browser(params: &Value, cancelled: &dyn Fn() -> bool) -> PlatformCommandResult {
    let operation_deadline = Instant::now() + DEBUG_TIMEOUT;
    let host = match loopback_host(params.get("host").and_then(Value::as_str)) {
        Ok(value) => value,
        Err(error) => return failed(error),
    };
    let port = match debugger_port(params) {
        Ok(value) => value,
        Err(error) => return failed(error),
    };
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(value) => value,
        Err(error) => return failed(format!("Cannot create browser debugger client: {error}")),
    };
    let origin = if host == "::1" {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    };
    let version = match fetch_bounded_json::<Value>(
        &client,
        format!("{origin}/json/version"),
        "browser debugger version",
    ) {
        Ok(value) => value,
        Err(error) => {
            return failed(format!(
                "Cannot connect to the browser DevTools endpoint: {error}"
            ))
        }
    };
    let targets = match fetch_bounded_json::<Vec<Value>>(
        &client,
        format!("{origin}/json/list"),
        "browser debugger target list",
    ) {
        Ok(value) if !value.is_empty() => value,
        Ok(_) => return failed("Browser DevTools endpoint has no debuggable targets"),
        Err(error) => return failed(format!("Cannot list browser debugger targets: {error}")),
    };
    let requested_target = match params.get("targetId").and_then(Value::as_str) {
        Some(value) if !value.is_empty() && value.len() <= 256 => value,
        _ => return failed("Missing or invalid required parameter: targetId"),
    };
    let expected_url = match params.get("expectedUrl").and_then(Value::as_str) {
        Some(value) if !value.is_empty() && value.len() <= 4_096 => value,
        _ => return failed("Missing or invalid required parameter: expectedUrl"),
    };
    let target = targets
        .iter()
        .find(|target| target.get("id").and_then(Value::as_str) == Some(requested_target));
    let target = match target {
        Some(value) => value,
        None => return failed("Browser debugger target was not found"),
    };
    if target.get("url").and_then(Value::as_str) != Some(expected_url) {
        return failed("Browser debugger target URL changed after local approval");
    }
    let websocket_url = match target.get("webSocketDebuggerUrl").and_then(Value::as_str) {
        Some(value) => value,
        None => return failed("Browser target does not expose a DevTools WebSocket"),
    };
    let websocket_url = match validate_loopback_websocket(websocket_url, port) {
        Ok(value) => value,
        Err(error) => return failed(error),
    };
    let mut socket = match connect_browser_socket(&websocket_url, operation_deadline) {
        Ok(value) => value,
        Err(error) => return failed(error),
    };
    let mut events = Vec::new();
    for (id, method) in [
        (1, "Runtime.enable"),
        (2, "Debugger.enable"),
        (3, "Log.enable"),
    ] {
        if let Err(error) = cdp_request(
            &mut socket,
            id,
            method,
            json!({}),
            &mut events,
            cancelled,
            operation_deadline,
        ) {
            return failed(error);
        }
    }
    let expression = params.get("expression").and_then(Value::as_str);
    if expression.is_some_and(|value| value.len() > 8_192 || value.contains('\0')) {
        return failed("Browser debugger expression exceeds 8192 characters or contains NUL");
    }
    let evaluation = match expression {
        Some(expression) => {
            let expected_url_literal = serde_json::to_string(expected_url).unwrap_or_default();
            let guarded_expression = format!(
                "if (globalThis.location.href !== {expected_url_literal}) {{ throw new Error('Termes debugger target URL changed'); }}\n{expression}"
            );
            match cdp_request(
                &mut socket,
                4,
                "Runtime.evaluate",
                json!({
                    "expression": guarded_expression,
                    "awaitPromise": params.get("awaitPromise").and_then(Value::as_bool).unwrap_or(true),
                    "returnByValue": true,
                    "generatePreview": true,
                }),
                &mut events,
                cancelled,
                operation_deadline,
            ) {
                Ok(value) if value.get("exceptionDetails").is_some() => {
                    return failed("Browser debugger evaluation was rejected by the target context")
                }
                Ok(value) => Some(
                    if serde_json::to_vec(&value).is_ok_and(|value| value.len() <= 64 * 1024) {
                        value
                    } else {
                        json!({ "truncated": true, "reason": "evaluation result exceeded 64 KiB" })
                    },
                ),
                Err(error) => return failed(error),
            }
        }
        None => None,
    };
    let collect_ms = params
        .get("collectMs")
        .and_then(Value::as_u64)
        .unwrap_or(250)
        .clamp(0, 2_000);
    let collect_deadline =
        (Instant::now() + Duration::from_millis(collect_ms)).min(operation_deadline);
    while Instant::now() < collect_deadline && !cancelled() {
        match socket.read() {
            Ok(Message::Text(text)) => {
                if let Ok(value) = serde_json::from_str::<Value>(text.as_str()) {
                    if value.get("method").is_some() {
                        push_cdp_event(&mut events, value);
                    }
                }
            }
            Ok(Message::Ping(payload)) => {
                let _ = socket.send(Message::Pong(payload));
            }
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) | Ok(Message::Close(_)) => break,
            Ok(_) => {}
        }
    }
    let _ = socket.close(None);
    if cancelled() {
        return failed("Browser debugger was cancelled by the local emergency stop");
    }
    completed(json!({
        "protocol": "cdp",
        "browser": version,
        "target": {
            "id": target.get("id"),
            "type": target.get("type"),
            "title": target.get("title"),
            "url": target.get("url"),
        },
        "evaluation": evaluation,
        "events": events,
    }))
}

pub fn browser_targets(params: &Value) -> PlatformCommandResult {
    let host = match loopback_host(params.get("host").and_then(Value::as_str)) {
        Ok(value) => value,
        Err(error) => return failed(error),
    };
    let port = match debugger_port(params) {
        Ok(value) => value,
        Err(error) => return failed(error),
    };
    let origin = if host == "::1" {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    };
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(value) => value,
        Err(error) => return failed(format!("Cannot create browser debugger client: {error}")),
    };
    let version = match fetch_bounded_json::<Value>(
        &client,
        format!("{origin}/json/version"),
        "browser debugger version",
    ) {
        Ok(value) => value,
        Err(error) => return failed(format!("Cannot read browser debugger version: {error}")),
    };
    let targets = match fetch_bounded_json::<Vec<Value>>(
        &client,
        format!("{origin}/json/list"),
        "browser debugger target list",
    ) {
        Ok(value) => value,
        Err(error) => return failed(format!("Cannot list browser debugger targets: {error}")),
    };
    completed(json!({ "protocol": "cdp", "browser": version, "targets": targets }))
}

#[cfg(target_os = "windows")]
fn visual_studio_installations() -> Vec<(PathBuf, String)> {
    let mut installations = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(program_files) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        for (version_directory, dte_major) in [("18", "18"), ("2022", "17"), ("2019", "16")] {
            for edition in ["Enterprise", "Professional", "Community", "BuildTools"] {
                let root = program_files
                    .join("Microsoft Visual Studio")
                    .join(version_directory)
                    .join(edition);
                if root.join("Common7/IDE/devenv.exe").is_file() {
                    installations.push((root, dte_major.to_owned()));
                }
            }
        }
    }
    installations
}

#[cfg(target_os = "windows")]
fn find_visual_studio_jit_debugger() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("TERMES_VISUAL_STUDIO_DEBUGGER").map(PathBuf::from) {
        if explicit.is_file()
            && explicit.file_name().and_then(|value| value.to_str()) == Some("vsjitdebugger.exe")
        {
            return Some(explicit);
        }
    }
    for (root, _) in visual_studio_installations() {
        let path = root.join("Common7/IDE/vsjitdebugger.exe");
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn find_visual_studio_dte() -> Option<(PathBuf, String)> {
    visual_studio_installations()
        .into_iter()
        .map(|(root, major)| {
            (
                root.join("Common7/IDE/devenv.exe"),
                format!("VisualStudio.DTE.{major}.0"),
            )
        })
        .next()
}

#[cfg(target_os = "windows")]
fn attach_with_visual_studio_dte(
    pid: u32,
    prog_id: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
$targetPid = __PID__
$progId = '__PROGID__'
try { $dte = [Runtime.InteropServices.Marshal]::GetActiveObject($progId) } catch {
  $type = [Type]::GetTypeFromProgID($progId)
  if ($null -eq $type) { throw "Visual Studio automation is not registered: $progId" }
  $dte = [Activator]::CreateInstance($type)
}
$dte.UserControl = $true
$dte.MainWindow.Visible = $true
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  $target = @($dte.Debugger.LocalProcesses) | Where-Object { $_.ProcessID -eq $targetPid } | Select-Object -First 1
  if ($null -eq $target) { Start-Sleep -Milliseconds 200 }
} while ($null -eq $target -and [DateTime]::UtcNow -lt $deadline)
if ($null -eq $target) { throw "Visual Studio cannot see process $targetPid" }
$target.Attach()
Start-Sleep -Milliseconds 300
$attached = @($dte.Debugger.DebuggedProcesses) | Where-Object { $_.ProcessID -eq $targetPid } | Select-Object -First 1
if ($null -eq $attached) { throw "Visual Studio did not report process $targetPid as attached" }
[pscustomobject]@{ attached = $true; pid = $targetPid; debugger = $progId } | ConvertTo-Json -Compress
"#
    .replace("__PID__", &pid.to_string())
    .replace("__PROGID__", prog_id);
    let (stdout, stderr) = run_debugger_command(
        Command::new("powershell.exe").args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ]),
        cancelled,
    )?;
    let attachment: Value = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Visual Studio returned an invalid attachment result: {error}"))?;
    Ok(json!({
        "protocol": "visual-studio-dte",
        "pid": pid,
        "attachment": attachment,
        "stderr": stderr,
    }))
}

pub fn visual_studio_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        find_visual_studio_jit_debugger().is_some() || find_visual_studio_dte().is_some()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

pub fn visual_studio(params: &Value, cancelled: &dyn Fn() -> bool) -> PlatformCommandResult {
    let pid = match required_pid(params) {
        Ok(value) => value,
        Err(error) => return failed(error),
    };
    #[cfg(target_os = "windows")]
    {
        if let Err(error) = validate_process_identity(params, pid) {
            return failed(error);
        }
        if cancelled() {
            return failed(
                "Visual Studio debugger handoff was cancelled by the local emergency stop",
            );
        }
        if let Some(debugger) = find_visual_studio_jit_debugger() {
            let mut command = Command::new(&debugger);
            command
                .args(["-p", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            configure_debugger_process(&mut command);
            let mut handoff = match command.spawn() {
                Ok(value) => value,
                Err(error) => {
                    return failed(format!("Cannot launch Visual Studio debugger: {error}"))
                }
            };
            let observation_deadline = Instant::now() + Duration::from_secs(1);
            loop {
                match handoff.try_wait() {
                    Ok(Some(status)) if !status.success() => {
                        return failed(format!(
                            "Visual Studio debugger handoff exited with {status}"
                        ))
                    }
                    Ok(Some(_)) => break,
                    Ok(None) if cancelled() => {
                        terminate_debugger_process_tree(&mut handoff);
                        return failed(
                            "Visual Studio debugger handoff was cancelled by the local emergency stop",
                        );
                    }
                    Ok(None) if Instant::now() < observation_deadline => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Ok(None) => break,
                    Err(error) => {
                        terminate_debugger_process_tree(&mut handoff);
                        return failed(format!(
                            "Cannot observe Visual Studio debugger handoff: {error}"
                        ));
                    }
                }
            }
            return completed(json!({
                "protocol": "visual-studio-jit-debugger-handoff",
                "pid": pid,
                "debuggerPath": debugger,
                "launchRequested": true,
                "handoffProcessId": handoff.id(),
            }));
        }
        match find_visual_studio_dte() {
            Some((_devenv, prog_id)) => {
                match attach_with_visual_studio_dte(pid, &prog_id, cancelled) {
                    Ok(result) => completed(result),
                    Err(error) => failed(error),
                }
            }
            None => failed(
                "Visual Studio debugger automation was not found in an installed Visual Studio instance",
            ),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cancelled;
        failed(format!(
            "Visual Studio process attachment is available only on Windows with Visual Studio installed (requested PID {pid})"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn remote_debugger_endpoints_are_rejected() {
        assert!(loopback_host(Some("example.com")).is_err());
        assert!(loopback_host(Some("localhost")).is_err());
        assert!(
            validate_loopback_websocket("ws://example.com:9222/devtools/page/1", 9222).is_err()
        );
        assert!(validate_loopback_websocket("ws://127.0.0.1:9333/devtools/page/1", 9222).is_err());
        assert!(
            validate_loopback_websocket("ws://user@127.0.0.1:9222/devtools/page/1", 9222).is_err()
        );
        assert_eq!(loopback_host(Some("127.0.0.1")).unwrap(), "127.0.0.1");
        assert!(validate_loopback_websocket("ws://[::1]:9222/devtools/page/1", 9222).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires macOS Developer Tools permission"]
    fn live_console_debugger_samples_process_stacks() {
        let mut target = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut system = System::new_all();
        system.refresh_all();
        let process = system.process(Pid::from_u32(target.id())).unwrap();
        let result = console(
            &json!({
                "pid": target.id(),
                "expectedExecutable": process.exe().and_then(Path::to_str).unwrap(),
                "expectedStartTimeUnixSeconds": process.start_time(),
                "expectedUserId": process.user_id().map(|value| format!("{value:?}")).unwrap(),
            }),
            &|| false,
        );
        let _ = target.kill();
        let _ = target.wait();

        assert_eq!(result.status, "completed", "{}", result.stderr);
        assert!(result.stdout.contains("Call graph"), "{}", result.stdout);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires locally installed Google Chrome"]
    fn live_browser_debugger_connects_evaluates_and_collects_console_events() {
        let chrome = Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
        assert!(chrome.is_file(), "Google Chrome is not installed");
        let profile = tempdir().unwrap();
        let mut target = Command::new(chrome)
            .args([
                "--headless=new",
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "about:blank",
            ])
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let active_port = profile.path().join("DevToolsActivePort");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !active_port.is_file() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        let port = fs::read_to_string(&active_port)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let targets = browser_targets(&json!({ "port": port }));
        assert_eq!(targets.status, "completed", "{}", targets.stderr);
        let targets: Value = serde_json::from_str(&targets.stdout).unwrap();
        let page = targets
            .get("targets")
            .and_then(Value::as_array)
            .and_then(|targets| {
                targets
                    .iter()
                    .find(|target| target.get("type").and_then(Value::as_str) == Some("page"))
            })
            .unwrap();
        let target_id = page.get("id").and_then(Value::as_str).unwrap();
        let expected_url = page.get("url").and_then(Value::as_str).unwrap();
        let result = browser(
            &json!({
                "port": port,
                "targetId": target_id,
                "expectedUrl": expected_url,
                "expression": "console.log('TERMES_BROWSER_CONSOLE_OK'); 'TERMES_BROWSER_EVAL_OK'",
                "collectMs": 500,
            }),
            &|| false,
        );
        let _ = target.kill();
        let _ = target.wait();

        assert_eq!(result.status, "completed", "{}", result.stderr);
        assert!(
            result.stdout.contains("TERMES_BROWSER_EVAL_OK"),
            "{}",
            result.stdout
        );
        assert!(
            result.stdout.contains("TERMES_BROWSER_CONSOLE_OK"),
            "{}",
            result.stdout
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn visual_studio_attachment_is_not_advertised_off_windows() {
        assert!(!visual_studio_available());
        let result = visual_studio(&json!({ "pid": 42 }), &|| false);
        assert_eq!(result.status, "failed");
        assert!(result.stderr.contains("only on Windows"));
    }
}
