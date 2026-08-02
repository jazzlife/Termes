use crate::model::{
    ConnectorArtifact, DesktopPlatform, PermissionState, PermissionValue, PlatformCommandResult,
};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Pid, Signal, System};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
#[cfg(target_os = "windows")]
use std::os::windows::{io::AsRawHandle, process::CommandExt};
#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
    },
};

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_PROCESSES: usize = 500;
const MAX_DEVELOPMENT_FILES: usize = 20;
const MAX_DEVELOPMENT_FILE_BYTES: usize = 64 * 1024;
const MAX_DEVELOPMENT_TOTAL_BYTES: usize = 256 * 1024;
const DEFAULT_DEVELOPMENT_TIMEOUT_MS: u64 = 15_000;
const MIN_DEVELOPMENT_TIMEOUT_MS: u64 = 1_000;
const MAX_DEVELOPMENT_TIMEOUT_MS: u64 = 55_000;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef)
        -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
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

fn valid_app_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

fn development_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 240 || value.contains('\0') {
        return Err("Development app file must use a bounded relative path".to_owned());
    }
    let path = PathBuf::from(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Development app file must use a safe relative path".to_owned());
    }
    Ok(path)
}

fn resolve_node_runtime() -> Result<PathBuf, String> {
    let executable = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ]);
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|directory| directory.join(executable)));
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "Node.js runtime was not found on this device".to_owned())
}

fn development_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library/Application Support/Termes Connector/development-apps"));
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|local| local.join("Termes Connector/development-apps"));
    root.ok_or_else(|| "Cannot resolve the Connector development app directory".to_owned())
}

fn read_bounded_stream(mut stream: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = stream
        .by_ref()
        .take((MAX_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes);
    let truncated = bytes.len() > MAX_OUTPUT_BYTES;
    bytes.truncate(MAX_OUTPUT_BYTES);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        text.push_str("\n[output truncated by Termes Connector]");
    }
    text
}

struct DevelopmentProcessTree {
    pid: u32,
    #[cfg(target_os = "windows")]
    job: HANDLE,
}

impl DevelopmentProcessTree {
    fn configure(command: &mut Command) {
        #[cfg(target_os = "macos")]
        {
            command.process_group(0);
        }
        #[cfg(target_os = "windows")]
        {
            command.creation_flags(CREATE_SUSPENDED);
        }
    }

    fn attach(child: &mut std::process::Child) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        {
            Ok(Self { pid: child.id() })
        }
        #[cfg(target_os = "windows")]
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("Cannot create the Windows development process job".to_owned());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0
            {
                CloseHandle(job);
                return Err("Cannot isolate the Windows development process tree".to_owned());
            }
            Ok(Self {
                pid: child.id(),
                job,
            })
        }
    }

    fn terminate(&self) {
        #[cfg(target_os = "macos")]
        unsafe {
            let _ = libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
        #[cfg(target_os = "windows")]
        unsafe {
            let _ = TerminateJobObject(self.job, 1);
        }
    }

    fn resume(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            Ok(())
        }
        #[cfg(target_os = "windows")]
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("Cannot enumerate the suspended Windows development process".to_owned());
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut found = Thread32First(snapshot, &mut entry) != 0;
            while found {
                if entry.th32OwnerProcessID == self.pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        let resumed = ResumeThread(thread);
                        CloseHandle(thread);
                        CloseHandle(snapshot);
                        if resumed != u32::MAX {
                            return Ok(());
                        }
                        return Err(
                            "Cannot resume the isolated Windows development process".to_owned()
                        );
                    }
                }
                found = Thread32Next(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            Err("Cannot find the suspended Windows development process thread".to_owned())
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for DevelopmentProcessTree {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.job);
        }
    }
}

struct TransientDevelopmentDirectory {
    path: PathBuf,
}

impl TransientDevelopmentDirectory {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn moved_to(&mut self, path: PathBuf) {
        self.path = path;
    }

    fn finish(mut self, mut result: PlatformCommandResult) -> PlatformCommandResult {
        match remove_transient_development_path(&self.path) {
            Ok(()) => self.path.clear(),
            Err(error) => {
                result.status = "failed".to_owned();
                result.exit_code = Some(1);
                if !result.stderr.is_empty() {
                    result.stderr.push('\n');
                }
                result.stderr.push_str(&error);
            }
        }
        result
    }
}

impl Drop for TransientDevelopmentDirectory {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            if let Err(error) = remove_transient_development_path(&self.path) {
                eprintln!("Termes Connector transient source cleanup failed: {error}");
            }
        }
    }
}

fn remove_transient_development_path(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Cannot inspect transient development source: {error}"
            ))
        }
    };
    let removal = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    removal.map_err(|error| format!("Cannot remove transient development app source: {error}"))
}

fn prepare_development_root(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("Cannot create Connector development app root: {error}"))?;
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Cannot inspect Connector development app root: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Connector development app root must be a real directory".to_owned());
    }
    let entries = fs::read_dir(root)
        .map_err(|error| format!("Cannot inspect stale development app source: {error}"))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Cannot inspect stale development app source: {error}"))?;
        remove_transient_development_path(&entry.path())?;
    }
    Ok(())
}

pub fn cleanup_stale_development_sources() -> Result<(), String> {
    let root = development_root()?;
    prepare_development_root(&root)
}

pub fn development_app_timeout_ms(params: &Value) -> u64 {
    bounded_u64(
        params,
        "timeoutMs",
        DEFAULT_DEVELOPMENT_TIMEOUT_MS,
        MIN_DEVELOPMENT_TIMEOUT_MS,
        MAX_DEVELOPMENT_TIMEOUT_MS,
    )
}

#[cfg(test)]
fn run_development_app_in_root(
    params: &Value,
    root: &Path,
    runtime: &Path,
) -> PlatformCommandResult {
    run_development_app_in_root_cancellable(params, root, runtime, &|| false)
}

fn run_development_app_in_root_cancellable(
    params: &Value,
    root: &Path,
    runtime: &Path,
    cancelled: &dyn Fn() -> bool,
) -> PlatformCommandResult {
    let app_id = match required_string(params, "appId", 80) {
        Ok(value) if valid_app_id(&value) => value,
        Ok(_) => {
            return failure(
                "appId must contain only letters, numbers, dots, underscores, or hyphens",
            )
        }
        Err(error) => return failure(error),
    };
    if params.get("runtime").and_then(Value::as_str) != Some("node") {
        return failure("runtime must be node");
    }
    let entrypoint_text = match required_string(params, "entrypoint", 240) {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    let entrypoint = match development_relative_path(&entrypoint_text) {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    if !matches!(
        entrypoint
            .extension()
            .and_then(|extension| extension.to_str()),
        Some("js" | "mjs" | "cjs")
    ) {
        return failure("Node.js entrypoint must end in .js, .mjs, or .cjs");
    }
    let file_values = match params.get("files").and_then(Value::as_array) {
        Some(files) if !files.is_empty() && files.len() <= MAX_DEVELOPMENT_FILES => files,
        _ => {
            return failure(format!(
                "files must contain 1 to {MAX_DEVELOPMENT_FILES} entries"
            ))
        }
    };
    let mut files = Vec::with_capacity(file_values.len());
    let mut seen = BTreeSet::new();
    let mut total_bytes = 0usize;
    for file in file_values {
        let path_text = match file.get("path").and_then(Value::as_str) {
            Some(value) => value,
            None => return failure("Each development file requires path and content"),
        };
        let path = match development_relative_path(path_text) {
            Ok(value) => value,
            Err(error) => return failure(error),
        };
        if !seen.insert(path.clone()) {
            return failure(format!("Duplicate development file path: {path_text}"));
        }
        let content = match file.get("content").and_then(Value::as_str) {
            Some(value) if value.len() <= MAX_DEVELOPMENT_FILE_BYTES => value,
            Some(_) => {
                return failure(format!(
                    "Development file {path_text} exceeds {MAX_DEVELOPMENT_FILE_BYTES} bytes"
                ))
            }
            None => return failure("Each development file requires path and content"),
        };
        total_bytes = match total_bytes.checked_add(content.len()) {
            Some(value) if value <= MAX_DEVELOPMENT_TOTAL_BYTES => value,
            _ => return failure("Development app source exceeds the total size limit"),
        };
        files.push((path, content));
    }
    if !seen.contains(&entrypoint) {
        return failure("entrypoint must be included in files");
    }
    let args = match params.get("args") {
        None => Vec::new(),
        Some(Value::Array(values)) if values.len() <= 16 => {
            let mut args = Vec::with_capacity(values.len());
            for value in values {
                match value.as_str() {
                    Some(argument) if argument.len() <= 512 && !argument.contains('\0') => {
                        args.push(argument.to_owned())
                    }
                    _ => return failure("args must contain at most 16 bounded strings"),
                }
            }
            args
        }
        _ => return failure("args must contain at most 16 bounded strings"),
    };
    let timeout_ms = development_app_timeout_ms(params);

    if let Err(error) = prepare_development_root(root) {
        return failure(error);
    }
    let staging = root.join(format!(".{app_id}-{}", Uuid::new_v4()));
    let mut transient = TransientDevelopmentDirectory::new(staging.clone());
    if let Err(error) = fs::create_dir(&staging) {
        return transient.finish(failure(format!(
            "Cannot create development app staging directory: {error}"
        )));
    }
    for (path, content) in &files {
        let destination = staging.join(path);
        if let Some(parent) = destination.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                return transient.finish(failure(format!(
                    "Cannot create development app directory: {error}"
                )));
            }
        }
        if let Err(error) = fs::write(&destination, content.as_bytes()) {
            return transient.finish(failure(format!(
                "Cannot write development app file: {error}"
            )));
        }
    }
    let app_root = root.join(&app_id);
    if let Ok(metadata) = fs::symlink_metadata(&app_root) {
        let removal = if metadata.is_dir() && !metadata.file_type().is_symlink() {
            fs::remove_dir_all(&app_root)
        } else {
            fs::remove_file(&app_root)
        };
        if let Err(error) = removal {
            return transient.finish(failure(format!(
                "Cannot replace the previous development app: {error}"
            )));
        }
    }
    if let Err(error) = fs::rename(&staging, &app_root) {
        return transient.finish(failure(format!(
            "Cannot activate development app files: {error}"
        )));
    }
    transient.moved_to(app_root.clone());

    let mut command = Command::new(runtime);
    command
        .current_dir(&app_root)
        .arg(&entrypoint)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("TERMES_APP_ID", &app_id)
        .env("TERMES_APP_ROOT", &app_root);
    for name in [
        "HOME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    DevelopmentProcessTree::configure(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return transient.finish(failure(format!(
                "Cannot start Node.js development app: {error}"
            )));
        }
    };
    let process_tree = match DevelopmentProcessTree::attach(&mut child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return transient.finish(failure(error));
        }
    };
    if let Err(error) = process_tree.resume() {
        process_tree.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return transient.finish(failure(error));
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || stdout.map(read_bounded_stream).unwrap_or_default());
    let stderr_reader = thread::spawn(move || stderr.map(read_bounded_stream).unwrap_or_default());
    let started = Instant::now();
    let mut timed_out = false;
    let mut was_cancelled = false;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                process_tree.terminate();
                break Some(status);
            }
            Ok(None) if cancelled() => {
                was_cancelled = true;
                process_tree.terminate();
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) if started.elapsed() < Duration::from_millis(timeout_ms) => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                timed_out = true;
                process_tree.terminate();
                let _ = child.kill();
                break child.wait().ok();
            }
            Err(error) => {
                process_tree.terminate();
                let _ = child.kill();
                let _ = child.wait();
                let stdout = stdout_reader.join().unwrap_or_default();
                let stderr = stderr_reader.join().unwrap_or_default();
                let result = PlatformCommandResult {
                    status: "failed".to_owned(),
                    stdout,
                    stderr: format!("{stderr}\nCannot wait for development app: {error}")
                        .trim()
                        .to_owned(),
                    exit_code: Some(1),
                    artifact: None,
                };
                return transient.finish(result);
            }
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let mut stderr = stderr_reader.join().unwrap_or_default();
    if timed_out {
        if !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str(&format!(
            "Termes app execution timed out after {timeout_ms} ms"
        ));
    }
    if was_cancelled {
        if !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str("Termes app execution was cancelled by the local emergency stop");
    }
    let exit_code = if was_cancelled {
        125
    } else if timed_out {
        124
    } else {
        exit_status.and_then(|status| status.code()).unwrap_or(1)
    };
    let result = PlatformCommandResult {
        status: if exit_code == 0 {
            "completed"
        } else {
            "failed"
        }
        .to_owned(),
        stdout,
        stderr,
        exit_code: Some(exit_code),
        artifact: None,
    };
    transient.finish(result)
}

fn run_development_app(params: &Value, cancelled: &dyn Fn() -> bool) -> PlatformCommandResult {
    let root = match development_root() {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    let runtime = match resolve_node_runtime() {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    run_development_app_in_root_cancellable(params, &root, &runtime, cancelled)
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
        "dev.app.run",
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
        open_macos_permission_settings(kind)
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

pub fn request_permission(kind: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        request_macos_permission_with(
            kind,
            request_accessibility_permission,
            request_screen_capture_permission,
            open_macos_permission_settings,
        )
    }
    #[cfg(target_os = "windows")]
    {
        let _ = kind;
        Err("Windows handles these connector capabilities through OS and session policy".to_owned())
    }
}

#[cfg(target_os = "macos")]
fn request_accessibility_permission() {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    let options = CFDictionary::from_CFType_pairs(&[(
        CFString::new("AXTrustedCheckOptionPrompt"),
        CFBoolean::true_value(),
    )]);
    unsafe {
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
    }
}

#[cfg(target_os = "macos")]
fn request_screen_capture_permission() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
fn open_macos_permission_settings(kind: &str) -> Result<(), String> {
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

#[cfg(target_os = "macos")]
fn request_macos_permission_with(
    kind: &str,
    request_accessibility: impl FnOnce(),
    request_screen_capture: impl FnOnce() -> bool,
    open_settings: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    match kind {
        "accessibility" | "inputControl" => {
            request_accessibility();
            Ok(())
        }
        "screenCapture" if request_screen_capture() => Ok(()),
        "screenCapture" => open_settings(kind),
        _ => Err("Unknown permission kind".to_owned()),
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

pub fn execute_cancellable(
    action: &str,
    params: &Value,
    cancelled: &dyn Fn() -> bool,
) -> PlatformCommandResult {
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
        "dev.app.run" => run_development_app(params, cancelled),
        _ => failure(format!("Unsupported connector action: {action}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;

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
        assert!(!is_read_only_action(&format!("{prefix}.dev.app.run")));
    }

    #[test]
    fn development_app_runs_node_and_returns_debug_streams() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("stale-crash-source")).unwrap();
        fs::write(
            root.path().join("stale-crash-source/main.js"),
            "console.log('stale')",
        )
        .unwrap();
        let runtime = resolve_node_runtime().expect("Node.js is required for connector tests");
        let result = run_development_app_in_root(
            &json!({
                "appId": "hello-debug",
                "runtime": "node",
                "entrypoint": "src/main.js",
                "files": [{
                    "path": "src/main.js",
                    "content": "console.log('TERMES_REMOTE_DEBUG_OK'); console.error('TERMES_REMOTE_STDERR_OK');"
                }],
                "args": [],
                "timeoutMs": 5_000
            }),
            root.path(),
            &runtime,
        );

        assert_eq!(result.status, "completed");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("TERMES_REMOTE_DEBUG_OK"));
        assert!(result.stderr.contains("TERMES_REMOTE_STDERR_OK"));
        assert!(!root.path().join("hello-debug").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn development_app_rejects_paths_outside_its_sandbox() {
        let root = tempdir().unwrap();
        let runtime = resolve_node_runtime().expect("Node.js is required for connector tests");
        let result = run_development_app_in_root(
            &json!({
                "appId": "escape-attempt",
                "runtime": "node",
                "entrypoint": "../outside.js",
                "files": [{ "path": "../outside.js", "content": "console.log('no')" }]
            }),
            root.path(),
            &runtime,
        );

        assert_eq!(result.status, "failed");
        assert!(result.stderr.contains("relative path"));
        assert!(!root.path().parent().unwrap().join("outside.js").exists());
    }

    #[test]
    fn development_app_timeout_terminates_the_process_tree_keeps_logs_and_removes_source() {
        let root = tempdir().unwrap();
        let runtime = resolve_node_runtime().expect("Node.js is required for connector tests");
        let started = Instant::now();
        let result = run_development_app_in_root(
            &json!({
                "appId": "timeout-app",
                "runtime": "node",
                "entrypoint": "main.js",
                "files": [{
                    "path": "main.js",
                    "content": "const { spawn } = require('node:child_process'); console.log('BEFORE_TIMEOUT'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', process.stdout, process.stderr] }); setTimeout(() => {}, 10_000);"
                }],
                "timeoutMs": 1_000
            }),
            root.path(),
            &runtime,
        );

        assert_eq!(result.status, "failed");
        assert_eq!(result.exit_code, Some(124));
        assert!(result.stdout.contains("BEFORE_TIMEOUT"));
        assert!(result.stderr.contains("timed out"));
        assert!(started.elapsed() < Duration::from_millis(2_500));
        assert!(!root.path().join("timeout-app").exists());
    }

    #[test]
    fn development_app_local_cancellation_terminates_and_removes_source() {
        let root = tempdir().unwrap();
        let runtime = resolve_node_runtime().expect("Node.js is required for connector tests");
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation_signal = Arc::clone(&cancelled);
        let signaler = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            cancellation_signal.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let result = run_development_app_in_root_cancellable(
            &json!({
                "appId": "cancelled-app",
                "runtime": "node",
                "entrypoint": "main.js",
                "files": [{
                    "path": "main.js",
                    "content": "console.log('BEFORE_CANCEL'); setTimeout(() => {}, 10_000);"
                }],
                "timeoutMs": 10_000
            }),
            root.path(),
            &runtime,
            &|| cancelled.load(Ordering::SeqCst),
        );
        signaler.join().unwrap();

        assert_eq!(result.status, "failed");
        assert_eq!(result.exit_code, Some(125));
        assert!(result.stdout.contains("BEFORE_CANCEL"));
        assert!(result.stderr.contains("local emergency stop"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!root.path().join("cancelled-app").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn accessibility_permission_request_does_not_hide_the_native_prompt() {
        let calls = RefCell::new(Vec::new());

        request_macos_permission_with(
            "accessibility",
            || {
                calls.borrow_mut().push("request-accessibility");
            },
            || {
                calls.borrow_mut().push("request-screen-capture");
                false
            },
            |_| {
                calls.borrow_mut().push("open-settings");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(calls.into_inner(), vec!["request-accessibility"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn denied_screen_capture_request_opens_settings() {
        let calls = RefCell::new(Vec::new());

        request_macos_permission_with(
            "screenCapture",
            || calls.borrow_mut().push("request-accessibility"),
            || {
                calls.borrow_mut().push("request-screen-capture");
                false
            },
            |_| {
                calls.borrow_mut().push("open-settings");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            calls.into_inner(),
            vec!["request-screen-capture", "open-settings"]
        );
    }
}
