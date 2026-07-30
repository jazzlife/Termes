use crate::model::{
    ConnectorArtifact, DesktopPlatform, PermissionState, PermissionValue, PlatformCommandResult,
};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use sysinfo::{Pid, Signal, System};
use uuid::Uuid;

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_PROCESSES: usize = 500;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

fn bounded_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_OUTPUT_BYTES)]).into_owned()
}

fn command_result(output: Output) -> Result<String, String> {
    if output.status.success() {
        Ok(bounded_text(&output.stdout))
    } else {
        Err(bounded_text(&output.stderr))
    }
}

fn success(stdout: impl Into<String>) -> PlatformCommandResult {
    PlatformCommandResult {
        status: "completed".to_owned(),
        stdout: stdout.into(),
        stderr: String::new(),
        exit_code: Some(0),
        artifact: None,
    }
}

fn failure(message: impl Into<String>) -> PlatformCommandResult {
    PlatformCommandResult {
        status: "failed".to_owned(),
        stdout: String::new(),
        stderr: message.into(),
        exit_code: Some(1),
        artifact: None,
    }
}

fn required_string(params: &Value, key: &str, maximum: usize) -> Result<String, String> {
    let value = params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing required parameter: {key}"))?;
    if value.len() > maximum {
        return Err(format!("Parameter {key} exceeds {maximum} characters"));
    }
    Ok(value.to_owned())
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

fn bounded_u64(params: &Value, key: &str, fallback: u64, minimum: u64, maximum: u64) -> u64 {
    params
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
        .clamp(minimum, maximum)
}

fn valid_identifier(value: &str) -> bool {
    value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || ".:_-\\/".contains(character))
}

pub fn capabilities() -> Vec<String> {
    let prefix = DesktopPlatform::current().action_prefix();
    [
        "system.info",
        "process.list",
        "screen.capture",
        "accessibility.snapshot",
        "input.click",
        "input.type",
        "app.launch",
        "app.terminate",
        "logs.query",
        "debug.process",
    ]
    .into_iter()
    .map(|action| format!("{prefix}.{action}"))
    .collect()
}

pub fn is_read_only_action(action: &str) -> bool {
    [".system.info", ".process.list"]
        .iter()
        .any(|suffix| action.ends_with(suffix))
}

pub fn permission_state() -> PermissionState {
    #[cfg(target_os = "macos")]
    {
        let accessibility = unsafe { AXIsProcessTrusted() };
        let screen_capture = unsafe { CGPreflightScreenCaptureAccess() };
        PermissionState {
            accessibility: if accessibility {
                PermissionValue::Granted
            } else {
                PermissionValue::Denied
            },
            screen_capture: if screen_capture {
                PermissionValue::Granted
            } else {
                PermissionValue::Denied
            },
            input_control: if accessibility {
                PermissionValue::Granted
            } else {
                PermissionValue::Denied
            },
            process_inspection: PermissionValue::Granted,
        }
    }
    #[cfg(target_os = "windows")]
    {
        PermissionState {
            accessibility: PermissionValue::Granted,
            screen_capture: PermissionValue::Granted,
            input_control: PermissionValue::Granted,
            process_inspection: PermissionValue::Granted,
        }
    }
}

pub fn open_permission_settings(kind: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match kind {
            "accessibility" | "inputControl" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "screenCapture" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            _ => return Err("Unknown permission kind".to_owned()),
        };
        Command::new("/usr/bin/open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Cannot open macOS System Settings: {error}"))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = kind;
        Err(
            "Windows does not expose a separate permission page for these connector capabilities"
                .to_owned(),
        )
    }
}

fn system_info() -> PlatformCommandResult {
    let mut system = System::new_all();
    system.refresh_all();
    let disks = sysinfo::Disks::new_with_refreshed_list()
        .iter()
        .map(|disk| {
            json!({
                "name": disk.name().to_string_lossy(),
                "mountPoint": disk.mount_point().to_string_lossy(),
                "fileSystem": disk.file_system().to_string_lossy(),
                "totalBytes": disk.total_space(),
                "availableBytes": disk.available_space(),
            })
        })
        .collect::<Vec<_>>();
    let networks = sysinfo::Networks::new_with_refreshed_list()
        .iter()
        .map(|(name, data)| {
            json!({
                "name": name,
                "receivedBytes": data.total_received(),
                "transmittedBytes": data.total_transmitted(),
            })
        })
        .collect::<Vec<_>>();
    let payload = json!({
        "platform": DesktopPlatform::current(),
        "hostName": System::host_name(),
        "osName": System::name(),
        "osVersion": System::long_os_version(),
        "kernelVersion": System::kernel_version(),
        "cpuArchitecture": std::env::consts::ARCH,
        "logicalCpuCount": system.cpus().len(),
        "totalMemoryBytes": system.total_memory(),
        "availableMemoryBytes": system.available_memory(),
        "uptimeSeconds": System::uptime(),
        "disks": disks,
        "networks": networks,
    });
    success(serde_json::to_string_pretty(&payload).unwrap_or_default())
}

fn process_list() -> PlatformCommandResult {
    let mut system = System::new_all();
    system.refresh_all();
    let mut processes = system
        .processes()
        .iter()
        .map(|(pid, process)| {
            json!({
                "pid": pid.as_u32(),
                "parentPid": process.parent().map(|value| value.as_u32()),
                "name": process.name().to_string_lossy(),
                "executable": process.exe().map(|value| value.to_string_lossy()),
                "status": format!("{:?}", process.status()).to_lowercase(),
                "memoryBytes": process.memory(),
                "cpuPercent": process.cpu_usage(),
                "runTimeSeconds": process.run_time(),
            })
        })
        .collect::<Vec<_>>();
    processes.sort_by_key(|entry| entry.get("pid").and_then(Value::as_u64).unwrap_or(0));
    processes.truncate(MAX_PROCESSES);
    success(serde_json::to_string_pretty(&json!({ "processes": processes })).unwrap_or_default())
}

fn capture_screen() -> PlatformCommandResult {
    let path = std::env::temp_dir().join(format!("termes-capture-{}.jpg", Uuid::new_v4()));
    let capture = capture_screen_to(&path);
    if let Err(error) = capture {
        return failure(error);
    }
    let result = fs::read(&path)
        .map_err(|error| format!("Cannot read captured screen: {error}"))
        .and_then(|bytes| {
            if bytes.is_empty() || bytes.len() > 6 * 1024 * 1024 {
                return Err("Captured screen exceeds the 6 MiB evidence limit".to_owned());
            }
            let checksum = hex::encode(Sha256::digest(&bytes));
            Ok(ConnectorArtifact {
                mime_type: "image/jpeg".to_owned(),
                base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                sha256: checksum,
                metadata: json!({
                    "captureTimestamp": chrono::Utc::now().to_rfc3339(),
                    "coordinateSpace": "virtual-desktop-physical-pixels",
                    "platform": DesktopPlatform::current(),
                }),
            })
        });
    let _ = fs::remove_file(&path);
    match result {
        Ok(artifact) => PlatformCommandResult {
            status: "completed".to_owned(),
            stdout: "Screen captured".to_owned(),
            stderr: String::new(),
            exit_code: Some(0),
            artifact: Some(artifact),
        },
        Err(error) => failure(error),
    }
}

#[cfg(target_os = "macos")]
fn capture_screen_to(path: &PathBuf) -> Result<(), String> {
    command_result(
        Command::new("/usr/sbin/screencapture")
            .args(["-x", "-t", "jpg"])
            .arg(path)
            .output()
            .map_err(|error| format!("Cannot start macOS screen capture: {error}"))?,
    )
    .map(|_| ())
}

#[cfg(target_os = "windows")]
fn capture_screen_to(path: &PathBuf) -> Result<(), String> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save($env:TERMES_CAPTURE_PATH, [System.Drawing.Imaging.ImageFormat]::Jpeg)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
"#;
    command_result(
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("TERMES_CAPTURE_PATH", path)
            .output()
            .map_err(|error| format!("Cannot start Windows screen capture: {error}"))?,
    )
    .map(|_| ())
}

#[cfg(target_os = "macos")]
fn accessibility_snapshot(params: &Value) -> PlatformCommandResult {
    let depth = bounded_u64(params, "depth", 4, 1, 6);
    let limit = bounded_u64(params, "limit", 300, 1, 600);
    let script = r#"
ObjC.import('Foundation');
const se = Application('System Events');
const candidates = se.applicationProcesses.whose({frontmost: true})();
if (!candidates.length) throw new Error('No foreground application');
const app = candidates[0];
let count = 0;
function safe(fn, fallback) { try { const value = fn(); return value === undefined ? fallback : value; } catch (_) { return fallback; } }
function node(el, depth) {
  if (count++ >= Number($.getenv('TERMES_AX_LIMIT'))) return null;
  const result = {
    role: safe(() => el.role(), ''),
    subrole: safe(() => el.subrole(), ''),
    title: safe(() => el.title(), ''),
    description: safe(() => el.description(), ''),
    value: safe(() => { const v = el.value(); return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null; }, null),
    enabled: safe(() => el.enabled(), null),
    position: safe(() => el.position(), null),
    size: safe(() => el.size(), null),
    children: []
  };
  if (depth > 0) {
    const children = safe(() => el.uiElements(), []);
    for (const child of children) {
      const next = node(child, depth - 1);
      if (next) result.children.push(next);
      if (count >= Number($.getenv('TERMES_AX_LIMIT'))) break;
    }
  }
  return result;
}
const windows = safe(() => app.windows(), []);
const roots = windows.slice(0, 8).map(w => node(w, Number($.getenv('TERMES_AX_DEPTH')))).filter(Boolean);
JSON.stringify({application: safe(() => app.name(), ''), pid: safe(() => app.unixId(), null), elementCount: count, windows: roots});
"#;
    let output = match Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", script])
        .env("TERMES_AX_DEPTH", depth.to_string())
        .env("TERMES_AX_LIMIT", limit.to_string())
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return failure(format!(
                "Cannot start macOS accessibility snapshot: {error}"
            ))
        }
    };
    match command_result(output) {
        Ok(output) => success(output),
        Err(error) => failure(error),
    }
}

#[cfg(target_os = "windows")]
fn accessibility_snapshot(params: &Value) -> PlatformCommandResult {
    let depth = bounded_u64(params, "depth", 4, 1, 6);
    let limit = bounded_u64(params, "limit", 300, 1, 600);
    let script = r#"
Add-Type -AssemblyName UIAutomationClient
$script:count = 0
$limit = [int]$env:TERMES_AX_LIMIT
function Read-Node([System.Windows.Automation.AutomationElement]$element, [int]$depth) {
  if ($null -eq $element -or $script:count -ge $limit) { return $null }
  $script:count++
  $node = [ordered]@{
    name = $element.Current.Name
    automationId = $element.Current.AutomationId
    controlType = $element.Current.ControlType.ProgrammaticName
    className = $element.Current.ClassName
    processId = $element.Current.ProcessId
    enabled = $element.Current.IsEnabled
    keyboardFocusable = $element.Current.IsKeyboardFocusable
    bounds = [ordered]@{ x = $element.Current.BoundingRectangle.X; y = $element.Current.BoundingRectangle.Y; width = $element.Current.BoundingRectangle.Width; height = $element.Current.BoundingRectangle.Height }
    children = @()
  }
  if ($depth -gt 0) {
    $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      $next = Read-Node $child ($depth - 1)
      if ($null -ne $next) { $node.children += $next }
      if ($script:count -ge $limit) { break }
    }
  }
  return $node
}
$root = [System.Windows.Automation.AutomationElement]::FocusedElement
[ordered]@{ elementCount = $script:count; root = (Read-Node $root ([int]$env:TERMES_AX_DEPTH)) } | ConvertTo-Json -Depth 12 -Compress
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("TERMES_AX_DEPTH", depth.to_string())
        .env("TERMES_AX_LIMIT", limit.to_string())
        .output();
    match output.map_err(|error| format!("Cannot start Windows UI Automation snapshot: {error}")) {
        Ok(output) => match command_result(output) {
            Ok(text) => success(text),
            Err(error) => failure(error),
        },
        Err(error) => failure(error),
    }
}

#[cfg(target_os = "macos")]
fn click(params: &Value) -> PlatformCommandResult {
    let x = params.get("x").and_then(Value::as_i64).unwrap_or(-1);
    let y = params.get("y").and_then(Value::as_i64).unwrap_or(-1);
    if x < 0 || y < 0 || x > 100_000 || y > 100_000 {
        return failure("Click coordinates are invalid");
    }
    let script = format!("tell application \"System Events\" to click at {{{x}, {y}}}");
    match Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
    {
        Ok(output) => match command_result(output) {
            Ok(_) => success(format!("Clicked at ({x}, {y})")),
            Err(error) => failure(error),
        },
        Err(error) => failure(format!("Cannot start macOS input event: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn click(params: &Value) -> PlatformCommandResult {
    let x = params.get("x").and_then(Value::as_i64).unwrap_or(-1);
    let y = params.get("y").and_then(Value::as_i64).unwrap_or(-1);
    if x < 0 || y < 0 || x > 100_000 || y > 100_000 {
        return failure("Click coordinates are invalid");
    }
    let script = r#"
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TermesInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[TermesInput]::SetCursorPos([int]$env:TERMES_X, [int]$env:TERMES_Y) | Out-Null
[TermesInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[TermesInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
"#;
    match Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("TERMES_X", x.to_string())
        .env("TERMES_Y", y.to_string())
        .output()
    {
        Ok(output) => match command_result(output) {
            Ok(_) => success(format!("Clicked at ({x}, {y})")),
            Err(error) => failure(error),
        },
        Err(error) => failure(format!("Cannot start Windows input event: {error}")),
    }
}

#[cfg(target_os = "macos")]
fn type_text(params: &Value) -> PlatformCommandResult {
    let text = match required_string(params, "text", 4_096) {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    let script = r#"on run argv
  tell application "System Events" to keystroke (item 1 of argv)
end run"#;
    match Command::new("/usr/bin/osascript")
        .args(["-e", script, "--", &text])
        .output()
    {
        Ok(output) => match command_result(output) {
            Ok(_) => success(format!("Typed {} characters", text.chars().count())),
            Err(error) => failure(error),
        },
        Err(error) => failure(format!("Cannot start macOS keyboard event: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn type_text(params: &Value) -> PlatformCommandResult {
    let text = match required_string(params, "text", 4_096) {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$text = $env:TERMES_INPUT_TEXT
$text = $text.Replace('{','{{}').Replace('}','{}}').Replace('+','{+}').Replace('^','{^}').Replace('%','{%}').Replace('~','{~}').Replace('(','{(}').Replace(')','{)}').Replace('[','{[}').Replace(']','{]}')
[System.Windows.Forms.SendKeys]::SendWait($text)
"#;
    match Command::new("powershell.exe")
        .args(["-NoProfile", "-Sta", "-Command", script])
        .env("TERMES_INPUT_TEXT", &text)
        .output()
    {
        Ok(output) => match command_result(output) {
            Ok(_) => success(format!("Typed {} characters", text.chars().count())),
            Err(error) => failure(error),
        },
        Err(error) => failure(format!("Cannot start Windows keyboard event: {error}")),
    }
}

fn launch_app(params: &Value) -> PlatformCommandResult {
    let app_id = match required_string(params, "appId", 260) {
        Ok(value) if valid_identifier(&value) => value,
        Ok(_) => return failure("appId contains unsupported characters"),
        Err(error) => return failure(error),
    };
    #[cfg(target_os = "macos")]
    let output = Command::new("/usr/bin/open").args(["-b", &app_id]).output();
    #[cfg(target_os = "windows")]
    let output = Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{app_id}"))
        .output();
    match output {
        Ok(output) => match command_result(output) {
            Ok(_) => success(format!("Launched application {app_id}")),
            Err(error) => failure(error),
        },
        Err(error) => failure(format!("Cannot launch application: {error}")),
    }
}

fn terminate_app(params: &Value) -> PlatformCommandResult {
    let pid = match required_pid(params) {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    let mut system = System::new_all();
    system.refresh_all();
    let process = match system.process(Pid::from_u32(pid)) {
        Some(value) => value,
        None => return failure(format!("Process {pid} was not found")),
    };
    if process.kill_with(Signal::Term).unwrap_or(false) {
        success(format!("Termination requested for process {pid}"))
    } else {
        failure(format!("Process {pid} refused termination"))
    }
}

#[cfg(target_os = "macos")]
fn query_logs(params: &Value) -> PlatformCommandResult {
    let minutes = bounded_u64(params, "minutes", 5, 1, 60);
    let process = params.get("process").and_then(Value::as_str).map(str::trim);
    let mut command = Command::new("/usr/bin/log");
    command.args(["show", "--style", "json", "--last", &format!("{minutes}m")]);
    if let Some(process) = process.filter(|value| !value.is_empty()) {
        if process.len() > 120 || !valid_identifier(process) {
            return failure("Process filter is invalid");
        }
        command.args(["--predicate", &format!("process == '{process}'")]);
    }
    match command.output() {
        Ok(output) => match command_result(output) {
            Ok(text) => success(text),
            Err(error) => failure(error),
        },
        Err(error) => failure(format!("Cannot query macOS unified logs: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn query_logs(params: &Value) -> PlatformCommandResult {
    let log_name = params
        .get("logName")
        .and_then(Value::as_str)
        .unwrap_or("System");
    if !["System", "Application"].contains(&log_name) {
        return failure("logName must be System or Application");
    }
    let max_events = bounded_u64(params, "maxEvents", 100, 1, 200);
    let script = r#"
Get-WinEvent -LogName $env:TERMES_LOG_NAME -MaxEvents ([int]$env:TERMES_MAX_EVENTS) |
  Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message |
  ConvertTo-Json -Depth 4 -Compress
"#;
    match Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("TERMES_LOG_NAME", log_name)
        .env("TERMES_MAX_EVENTS", max_events.to_string())
        .output()
    {
        Ok(output) => match command_result(output) {
            Ok(text) => success(text),
            Err(error) => failure(error),
        },
        Err(error) => failure(format!("Cannot query Windows Event Log: {error}")),
    }
}

fn debug_process(params: &Value) -> PlatformCommandResult {
    let pid = match required_pid(params) {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    let mut system = System::new_all();
    system.refresh_all();
    let process = match system.process(Pid::from_u32(pid)) {
        Some(value) => value,
        None => return failure(format!("Process {pid} was not found")),
    };
    let mut report = BTreeMap::new();
    report.insert("pid", json!(pid));
    report.insert("name", json!(process.name().to_string_lossy()));
    report.insert(
        "executable",
        json!(process.exe().map(|path| path.to_string_lossy())),
    );

    report.insert(
        "status",
        json!(format!("{:?}", process.status()).to_lowercase()),
    );
    report.insert("memoryBytes", json!(process.memory()));
    report.insert("cpuPercent", json!(process.cpu_usage()));
    report.insert("runTimeSeconds", json!(process.run_time()));

    #[cfg(target_os = "macos")]
    {
        match Command::new("/usr/bin/sample")
            .args([&pid.to_string(), "1", "1"])
            .output()
        {
            Ok(output) if output.status.success() => {
                report.insert("sample", json!(bounded_text(&output.stdout)));
            }
            Ok(output) => {
                report.insert("sampleError", json!(bounded_text(&output.stderr)));
            }
            Err(error) => {
                report.insert("sampleError", json!(error.to_string()));
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let script = "Get-Process -Id ([int]$env:TERMES_PID) | Select-Object Id,Name,Path,StartTime,Handles,Threads,WorkingSet64,PrivateMemorySize64,TotalProcessorTime | ConvertTo-Json -Depth 3 -Compress";
        match Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("TERMES_PID", pid.to_string())
            .output()
        {
            Ok(output) if output.status.success() => {
                report.insert("native", json!(bounded_text(&output.stdout)));
            }
            Ok(output) => {
                report.insert("nativeError", json!(bounded_text(&output.stderr)));
            }
            Err(error) => {
                report.insert("nativeError", json!(error.to_string()));
            }
        }
    }
    success(serde_json::to_string_pretty(&report).unwrap_or_default())
}

pub fn execute(action: &str, params: &Value) -> PlatformCommandResult {
    let prefix = DesktopPlatform::current().action_prefix();
    let expected = format!("{prefix}.");
    if !action.starts_with(&expected)
        || !capabilities().iter().any(|capability| capability == action)
    {
        return failure(format!("Unsupported connector action: {action}"));
    }
    match action.strip_prefix(&expected).unwrap_or_default() {
        "system.info" => system_info(),
        "process.list" => process_list(),
        "screen.capture" => capture_screen(),
        "accessibility.snapshot" => accessibility_snapshot(params),
        "input.click" => click(params),
        "input.type" => type_text(params),
        "app.launch" => launch_app(params),
        "app.terminate" => terminate_app(params),
        "logs.query" => query_logs(params),
        "debug.process" => debug_process(params),
        _ => failure(format!("Unsupported connector action: {action}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_allowlist_contains_only_typed_actions() {
        let prefix = DesktopPlatform::current().action_prefix();
        let actions = capabilities();
        assert!(actions.iter().all(|action| action.starts_with(prefix)));
        assert!(!actions.iter().any(|action| action.contains("shell")));
        assert!(!actions.iter().any(|action| action.contains("powershell")));
    }

    #[test]
    fn read_only_classifier_excludes_mutations() {
        let prefix = DesktopPlatform::current().action_prefix();
        assert!(is_read_only_action(&format!("{prefix}.system.info")));
        assert!(is_read_only_action(&format!("{prefix}.process.list")));
        assert!(!is_read_only_action(&format!("{prefix}.screen.capture")));
        assert!(!is_read_only_action(&format!(
            "{prefix}.accessibility.snapshot"
        )));
        assert!(!is_read_only_action(&format!("{prefix}.logs.query")));
        assert!(!is_read_only_action(&format!("{prefix}.debug.process")));
        assert!(!is_read_only_action(&format!("{prefix}.input.type")));
        assert!(!is_read_only_action(&format!("{prefix}.app.terminate")));
    }
}
