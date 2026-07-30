use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopPlatform {
    Windows,
    Macos,
}

impl DesktopPlatform {
    pub fn current() -> Self {
        #[cfg(target_os = "windows")]
        {
            Self::Windows
        }
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
    }

    pub fn action_prefix(&self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionValue {
    Granted,
    Denied,
    NotDetermined,
    Unsupported,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionState {
    pub accessibility: PermissionValue,
    pub screen_capture: PermissionValue,
    pub input_control: PermissionValue,
    pub process_inspection: PermissionValue,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSettings {
    pub api_base_url: String,
    pub connector_id: String,
    pub device_id: String,
    pub account_id: String,
    pub workspace_id: String,
    pub workspace_key: String,
    pub project_id: String,
    pub project_name: String,
    pub device_name: String,
    pub platform: DesktopPlatform,
    #[serde(default)]
    pub auto_observe: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairInput {
    pub api_base_url: String,
    pub pairing_code: String,
    pub device_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub connector_id: String,
    pub device_id: String,
    pub device_token: String,
    pub account_id: String,
    pub workspace_id: String,
    pub workspace_key: String,
    pub project_id: String,
    pub project_name: String,
    pub websocket_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionPhase {
    Unpaired,
    Offline,
    Connecting,
    Online,
    Busy,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub success: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub command_id: String,
    pub sequence: u64,
    pub action: String,
    pub params: Value,
    pub requested_at: String,
    pub deadline: String,
    pub read_only: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSnapshot {
    pub phase: ConnectionPhase,
    pub settings: Option<ConnectorSettings>,
    pub permissions: PermissionState,
    pub capabilities: Vec<String>,
    pub pending_approvals: Vec<PendingApproval>,
    pub activities: Vec<ActivityEntry>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEnvelope {
    pub protocol_version: u32,
    pub command_id: String,
    pub sequence: u64,
    pub action: String,
    pub params: Value,
    pub deadline: String,
    pub request_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorArtifact {
    pub mime_type: String,
    pub base64: String,
    pub sha256: String,
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResultMessage {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub command_id: String,
    pub sequence: u64,
    pub status: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub started_at: String,
    pub completed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ConnectorArtifact>,
}

#[derive(Clone, Debug)]
pub struct PlatformCommandResult {
    pub status: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub artifact: Option<ConnectorArtifact>,
}
