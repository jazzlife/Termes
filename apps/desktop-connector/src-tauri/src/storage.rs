use crate::model::{ConnectorSettings, DesktopPlatform};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "app.turtlelab.termes.connector";
const SETTINGS_FILE: &str = "connector.json";

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve connector data directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create connector data directory: {error}"))?;
    Ok(directory.join(SETTINGS_FILE))
}

pub fn load_settings(app: &AppHandle) -> Result<Option<ConnectorSettings>, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read connector settings: {error}"))?;
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| format!("Connector settings are invalid: {error}"))
}

pub fn save_settings(app: &AppHandle, settings: &ConnectorSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let content = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Cannot encode connector settings: {error}"))?;
    fs::write(&temporary, content)
        .map_err(|error| format!("Cannot write connector settings: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Cannot replace connector settings: {error}"))
}

pub fn delete_settings(app: &AppHandle) -> Result<(), String> {
    let path = settings_path(app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove connector settings: {error}")),
    }
}

pub fn save_device_token(connector_id: &str, token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, connector_id)
        .map_err(|error| format!("Cannot open OS credential storage: {error}"))?;
    entry
        .set_password(token)
        .map_err(|error| format!("Cannot save connector credential in OS secure storage: {error}"))
}

pub fn load_device_token(connector_id: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, connector_id)
        .map_err(|error| format!("Cannot open OS credential storage: {error}"))?;
    entry.get_password().map_err(|error| {
        format!("Cannot read connector credential from OS secure storage: {error}")
    })
}

pub fn delete_device_token(connector_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, connector_id)
        .map_err(|error| format!("Cannot open OS credential storage: {error}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Cannot remove connector credential: {error}")),
    }
}

fn platform_machine_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/sbin/ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            if !line.contains("IOPlatformUUID") {
                continue;
            }
            let value = line.split('=').nth(1)?.trim().trim_matches('"');
            if !value.is_empty() {
                return Some(value.to_owned());
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid",
            ])
            .output()
            .ok()?;
        let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

pub fn machine_fingerprint() -> String {
    let platform = DesktopPlatform::current();
    let stable_id = platform_machine_id().unwrap_or_else(|| {
        format!(
            "{}:{}:{}",
            hostname::get().unwrap_or_default().to_string_lossy(),
            whoami::username(),
            platform.action_prefix()
        )
    });
    let digest = Sha256::digest(stable_id.as_bytes());
    format!("{}:{}", platform.action_prefix(), hex::encode(digest))
}

pub fn default_device_name() -> String {
    let hostname = hostname::get()
        .unwrap_or_default()
        .to_string_lossy()
        .trim()
        .to_owned();
    if hostname.is_empty() {
        match DesktopPlatform::current() {
            DesktopPlatform::Macos => "My Mac".to_owned(),
            DesktopPlatform::Windows => "My Windows PC".to_owned(),
        }
    } else {
        hostname
    }
}
