use crate::model::{
    ActivityEntry, CommandEnvelope, CommandResultMessage, ConnectionPhase, ConnectorSettings,
    ConnectorSnapshot, PairInput, PairResponse, PendingApproval, PROTOCOL_VERSION,
};
use crate::{platform, storage};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header::AUTHORIZATION, HeaderValue};
use tokio_tungstenite::tungstenite::Message;
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
struct InnerState {
    phase: ConnectionPhase,
    settings: Option<ConnectorSettings>,
    pending_approvals: Vec<PendingApproval>,
    activities: Vec<ActivityEntry>,
    last_error: Option<String>,
}

pub struct ConnectorState {
    app: AppHandle,
    inner: RwLock<InnerState>,
    approval_senders: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    stop_sender: Mutex<Option<watch::Sender<bool>>>,
    connect_task: Mutex<Option<JoinHandle<()>>>,
    execution_generation: AtomicU64,
}

impl ConnectorState {
    pub fn new(app: AppHandle) -> Result<Arc<Self>, String> {
        let settings = storage::load_settings(&app)?;
        let phase = if settings.is_some() {
            ConnectionPhase::Offline
        } else {
            ConnectionPhase::Unpaired
        };
        Ok(Arc::new(Self {
            app,
            inner: RwLock::new(InnerState {
                phase,
                settings,
                pending_approvals: Vec::new(),
                activities: Vec::new(),
                last_error: None,
            }),
            approval_senders: Mutex::new(HashMap::new()),
            stop_sender: Mutex::new(None),
            connect_task: Mutex::new(None),
            execution_generation: AtomicU64::new(0),
        }))
    }

    pub fn snapshot(&self) -> ConnectorSnapshot {
        let inner = self.inner.read().expect("connector state poisoned").clone();
        ConnectorSnapshot {
            phase: inner.phase,
            settings: inner.settings,
            permissions: platform::permission_state(),
            capabilities: platform::capabilities(),
            pending_approvals: inner.pending_approvals,
            activities: inner.activities,
            last_error: inner.last_error,
        }
    }

    fn emit_snapshot(&self) {
        let _ = self.app.emit("connector-snapshot", self.snapshot());
    }

    fn update(&self, mutate: impl FnOnce(&mut InnerState)) {
        {
            let mut inner = self.inner.write().expect("connector state poisoned");
            mutate(&mut inner);
        }
        self.emit_snapshot();
    }

    fn set_phase(&self, phase: ConnectionPhase, error: Option<String>) {
        self.update(|inner| {
            inner.phase = phase;
            inner.last_error = error;
        });
    }

    fn add_activity(
        &self,
        kind: impl Into<String>,
        title: impl Into<String>,
        detail: impl Into<String>,
        success: Option<bool>,
    ) {
        let entry = ActivityEntry {
            id: Uuid::new_v4().to_string(),
            at: Utc::now().to_rfc3339(),
            kind: kind.into(),
            title: title.into(),
            detail: detail.into(),
            success,
        };
        self.update(|inner| {
            inner.activities.insert(0, entry);
            inner.activities.truncate(50);
        });
    }

    pub async fn pair(self: &Arc<Self>, input: PairInput) -> Result<ConnectorSnapshot, String> {
        let base_url = normalize_api_base_url(&input.api_base_url)?;
        let device_name = input.device_name.trim();
        if device_name.is_empty() || device_name.chars().count() > 120 {
            return Err("Device name must contain between 1 and 120 characters".to_owned());
        }
        self.disconnect_internal(false).await;
        self.set_phase(ConnectionPhase::Connecting, None);
        let permissions = platform::permission_state();
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("Cannot create connector HTTP client: {error}"))?
            .post(format!("{base_url}/api/desktop-connectors/pair"))
            .json(&json!({
                "pairingCode": input.pairing_code,
                "name": device_name,
                "platform": crate::model::DesktopPlatform::current(),
                "machineFingerprint": storage::machine_fingerprint(),
                "publicKey": Value::Null,
                "appVersion": env!("CARGO_PKG_VERSION"),
                "capabilities": platform::capabilities(),
                "permissions": permissions,
            }))
            .send()
            .await
            .map_err(|error| format!("Cannot reach the Termes pairing endpoint: {error}"))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            self.set_phase(
                ConnectionPhase::Unpaired,
                Some(format!("Pairing failed ({status})")),
            );
            return Err(api_error(&body, format!("Pairing failed ({status})")));
        }
        let paired: PairResponse = serde_json::from_str(&body)
            .map_err(|error| format!("Termes returned an invalid pairing response: {error}"))?;
        storage::save_device_token(&paired.connector_id, &paired.device_token)?;
        let settings = ConnectorSettings {
            api_base_url: base_url,
            connector_id: paired.connector_id.clone(),
            device_id: paired.device_id,
            account_id: paired.account_id,
            workspace_id: paired.workspace_id,
            workspace_key: paired.workspace_key,
            project_id: paired.project_id,
            project_name: paired.project_name,
            device_name: device_name.to_owned(),
            platform: crate::model::DesktopPlatform::current(),
            auto_observe: false,
        };
        if let Err(error) = storage::save_settings(&self.app, &settings) {
            let _ = storage::delete_device_token(&paired.connector_id);
            self.set_phase(ConnectionPhase::Unpaired, Some(error.clone()));
            return Err(error);
        }
        self.update(|inner| {
            inner.settings = Some(settings.clone());
            inner.phase = ConnectionPhase::Offline;
            inner.last_error = None;
        });
        self.add_activity(
            "pairing",
            "Workspace connected",
            format!("{} / {}", settings.workspace_key, settings.project_name),
            Some(true),
        );
        self.connect().await?;
        Ok(self.snapshot())
    }

    pub async fn connect(self: &Arc<Self>) -> Result<(), String> {
        self.disconnect_internal(false).await;
        let settings = self
            .inner
            .read()
            .expect("connector state poisoned")
            .settings
            .clone()
            .ok_or_else(|| "Pair this computer before connecting".to_owned())?;
        let token = storage::load_device_token(&settings.connector_id)?;
        let (stop_sender, stop_receiver) = watch::channel(false);
        *self.stop_sender.lock().await = Some(stop_sender);
        let state = Arc::clone(self);
        let task = tauri::async_runtime::spawn(async move {
            state.connection_loop(settings, token, stop_receiver).await;
        });
        *self.connect_task.lock().await = Some(task);
        Ok(())
    }

    pub async fn disconnect(self: &Arc<Self>) -> ConnectorSnapshot {
        self.disconnect_internal(true).await;
        self.snapshot()
    }

    async fn disconnect_internal(&self, record: bool) {
        if let Some(sender) = self.stop_sender.lock().await.take() {
            let _ = sender.send(true);
        }
        if let Some(task) = self.connect_task.lock().await.take() {
            task.abort();
        }
        self.reject_all_pending().await;
        let paired = self
            .inner
            .read()
            .expect("connector state poisoned")
            .settings
            .is_some();
        self.set_phase(
            if paired {
                ConnectionPhase::Offline
            } else {
                ConnectionPhase::Unpaired
            },
            None,
        );
        if record && paired {
            self.add_activity(
                "connection",
                "Disconnected",
                "Outbound session stopped locally",
                Some(true),
            );
        }
    }

    pub async fn forget(self: &Arc<Self>) -> Result<ConnectorSnapshot, String> {
        let connector_id = self
            .inner
            .read()
            .expect("connector state poisoned")
            .settings
            .as_ref()
            .map(|settings| settings.connector_id.clone());
        self.disconnect_internal(false).await;
        if let Some(connector_id) = connector_id {
            storage::delete_device_token(&connector_id)?;
        }
        storage::delete_settings(&self.app)?;
        self.update(|inner| {
            inner.settings = None;
            inner.phase = ConnectionPhase::Unpaired;
            inner.last_error = None;
            inner.pending_approvals.clear();
        });
        self.add_activity(
            "pairing",
            "Local pairing removed",
            "This app no longer holds the device credential",
            Some(true),
        );
        Ok(self.snapshot())
    }

    pub async fn set_auto_observe(&self, enabled: bool) -> Result<ConnectorSnapshot, String> {
        let settings = {
            let mut inner = self.inner.write().expect("connector state poisoned");
            let settings = inner
                .settings
                .as_mut()
                .ok_or_else(|| "Pair this computer before changing connector policy".to_owned())?;
            settings.auto_observe = enabled;
            settings.clone()
        };
        storage::save_settings(&self.app, &settings)?;
        self.emit_snapshot();
        Ok(self.snapshot())
    }

    pub async fn resolve_approval(&self, command_id: &str, approved: bool) -> Result<(), String> {
        let sender = self.approval_senders.lock().await.remove(command_id);
        let Some(sender) = sender else {
            return Err("The command is no longer awaiting approval".to_owned());
        };
        let _ = sender.send(approved);
        Ok(())
    }

    pub async fn emergency_stop(self: &Arc<Self>) -> ConnectorSnapshot {
        self.execution_generation.fetch_add(1, Ordering::SeqCst);
        self.reject_all_pending().await;
        self.disconnect_internal(false).await;
        self.add_activity(
            "safety",
            "Emergency stop",
            "Pending and new commands were stopped, in-flight results were discarded, and the outbound session was closed",
            Some(true),
        );
        self.snapshot()
    }

    async fn reject_all_pending(&self) {
        let mut senders = self.approval_senders.lock().await;
        for (_, sender) in senders.drain() {
            let _ = sender.send(false);
        }
        drop(senders);
        self.update(|inner| inner.pending_approvals.clear());
    }

    async fn connection_loop(
        self: Arc<Self>,
        settings: ConnectorSettings,
        token: String,
        mut stop: watch::Receiver<bool>,
    ) {
        let mut backoff = 2_u64;
        loop {
            if *stop.borrow() {
                break;
            }
            self.set_phase(ConnectionPhase::Connecting, None);
            match self.connect_once(&settings, &token, &mut stop).await {
                Ok(()) if *stop.borrow() => break,
                Ok(()) => {
                    self.set_phase(ConnectionPhase::Offline, None);
                }
                Err(error) => {
                    let revoked = error.contains("credential_revoked");
                    self.set_phase(ConnectionPhase::Error, Some(error.clone()));
                    self.add_activity("connection", "Connection lost", &error, Some(false));
                    if revoked {
                        break;
                    }
                }
            }
            if *stop.borrow() {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(backoff)) => {},
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() { break; }
                }
            }
            backoff = (backoff * 2).min(30);
        }
    }

    async fn connect_once(
        self: &Arc<Self>,
        settings: &ConnectorSettings,
        token: &str,
        stop: &mut watch::Receiver<bool>,
    ) -> Result<(), String> {
        let websocket_url = websocket_url(settings)?;
        let mut request = websocket_url
            .as_str()
            .into_client_request()
            .map_err(|error| format!("Cannot create connector WebSocket request: {error}"))?;
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| "Connector credential contains invalid header bytes".to_owned())?,
        );
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|error| format!("Cannot establish outbound connector session: {error}"))?;
        let (mut writer, mut reader) = socket.split();
        writer
            .send(Message::Text(
                json!({
                    "type": "hello",
                    "protocolVersion": PROTOCOL_VERSION,
                    "appVersion": env!("CARGO_PKG_VERSION"),
                    "capabilities": platform::capabilities(),
                    "permissions": platform::permission_state(),
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|error| format!("Cannot send connector handshake: {error}"))?;

        let (outbound, mut outbound_receiver) = mpsc::unbounded_channel::<Value>();
        let writer_task = tauri::async_runtime::spawn(async move {
            while let Some(value) = outbound_receiver.recv().await {
                if writer
                    .send(Message::Text(value.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let heartbeat_sender = outbound.clone();
        let heartbeat_task = tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            loop {
                interval.tick().await;
                if heartbeat_sender
                    .send(json!({
                        "type": "heartbeat",
                        "sentAt": protocol_timestamp(Utc::now()),
                        "capabilities": platform::capabilities(),
                        "permissions": platform::permission_state(),
                    }))
                    .is_err()
                {
                    break;
                }
            }
        });
        self.set_phase(ConnectionPhase::Online, None);
        self.add_activity(
            "connection",
            "Connected",
            format!("{} / {}", settings.workspace_key, settings.project_name),
            Some(true),
        );

        let result = loop {
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        break Ok(());
                    }
                }
                incoming = reader.next() => {
                    let Some(incoming) = incoming else {
                        break Err("Connector WebSocket closed without a close frame".to_owned());
                    };
                    let message = incoming.map_err(|error| format!("Connector WebSocket read failed: {error}"))?;
                    match message {
                        Message::Text(text) => {
                            let value: Value = serde_json::from_str(text.as_str())
                                .map_err(|error| format!("Termes sent invalid connector JSON: {error}"))?;
                            let message_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
                            match message_type {
                                "connected" | "ready" | "heartbeat.ack" => {},
                                "command" => {
                                    let envelope: CommandEnvelope = serde_json::from_value(value)
                                        .map_err(|error| format!("Termes sent an invalid command envelope: {error}"))?;
                                    let state = Arc::clone(self);
                                    let command_sender = outbound.clone();
                                    tauri::async_runtime::spawn(async move {
                                        state.handle_command(envelope, command_sender).await;
                                    });
                                }
                                _ => return Err(format!("Termes sent unsupported connector message: {message_type}")),
                            }
                        }
                        Message::Close(frame) => {
                            if frame.as_ref().is_some_and(|frame| u16::from(frame.code) == 4001_u16) {
                                break Err("credential_revoked: Termes revoked this connector".to_owned());
                            }
                            break Err(frame
                                .map(|frame| format!("Connector closed: {}", frame.reason))
                                .unwrap_or_else(|| "Connector closed".to_owned()));
                        }
                        Message::Ping(payload) => {
                            let _ = outbound.send(json!({
                                "type": "heartbeat",
                                "sentAt": protocol_timestamp(Utc::now()),
                                "pingBytes": payload.len(),
                            }));
                        }
                        Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {},
                    }
                }
            }
        };
        heartbeat_task.abort();
        drop(outbound);
        writer_task.abort();
        self.reject_all_pending().await;
        result
    }

    async fn handle_command(
        self: Arc<Self>,
        envelope: CommandEnvelope,
        outbound: mpsc::UnboundedSender<Value>,
    ) {
        let execution_generation = self.execution_generation.load(Ordering::SeqCst);
        let now = Utc::now();
        let deadline = DateTime::parse_from_rfc3339(&envelope.deadline)
            .map(|value| value.with_timezone(&Utc))
            .unwrap_or(now);
        let reject_reason = if envelope.protocol_version != PROTOCOL_VERSION {
            Some("Unsupported connector protocol version".to_owned())
        } else if command_request_hash(&envelope) != envelope.request_hash {
            Some("Command request hash does not match its payload".to_owned())
        } else if deadline <= now {
            Some("Command deadline has already expired".to_owned())
        } else if !platform::capabilities()
            .iter()
            .any(|action| action == &envelope.action)
        {
            Some("Action is not in the connector capability allowlist".to_owned())
        } else {
            None
        };
        if let Some(reason) = reject_reason {
            send_ack(&outbound, &envelope, false, Some(&reason));
            self.add_activity(
                "command",
                "Command rejected",
                format!("{}: {reason}", envelope.action),
                Some(false),
            );
            return;
        }

        let read_only = platform::is_read_only_action(&envelope.action);
        let auto_observe = self
            .inner
            .read()
            .expect("connector state poisoned")
            .settings
            .as_ref()
            .is_some_and(|settings| settings.auto_observe);
        let approved = if read_only && auto_observe {
            true
        } else {
            let pending = PendingApproval {
                command_id: envelope.command_id.clone(),
                sequence: envelope.sequence,
                action: envelope.action.clone(),
                params: redact_params(&envelope.action, &envelope.params),
                requested_at: now.to_rfc3339(),
                deadline: envelope.deadline.clone(),
                read_only,
            };
            let (sender, receiver) = oneshot::channel();
            self.approval_senders
                .lock()
                .await
                .insert(envelope.command_id.clone(), sender);
            self.update(|inner| inner.pending_approvals.push(pending));
            let wait = (deadline - Utc::now())
                .to_std()
                .unwrap_or_default()
                .min(Duration::from_secs(300));
            tokio::time::timeout(wait, receiver)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(false)
        };
        self.approval_senders
            .lock()
            .await
            .remove(&envelope.command_id);
        self.update(|inner| {
            inner
                .pending_approvals
                .retain(|pending| pending.command_id != envelope.command_id)
        });
        if !approved {
            send_ack(
                &outbound,
                &envelope,
                false,
                Some("Denied or expired in the local connector"),
            );
            self.add_activity("command", "Command denied", &envelope.action, Some(false));
            return;
        }
        if self.execution_generation.load(Ordering::SeqCst) != execution_generation {
            send_ack(
                &outbound,
                &envelope,
                false,
                Some("Cancelled by the local emergency stop"),
            );
            return;
        }

        send_ack(&outbound, &envelope, true, None);
        self.set_phase(ConnectionPhase::Busy, None);
        let started_at = Utc::now();
        let action = envelope.action.clone();
        let params = envelope.params.clone();
        let result =
            tauri::async_runtime::spawn_blocking(move || platform::execute(&action, &params)).await;
        let completed_at = Utc::now();
        if self.execution_generation.load(Ordering::SeqCst) != execution_generation {
            self.add_activity(
                "safety",
                "In-flight result discarded",
                envelope.action,
                Some(false),
            );
            return;
        }
        let result = match result {
            Ok(result) => result,
            Err(error) => crate::model::PlatformCommandResult {
                status: "failed".to_owned(),
                stdout: String::new(),
                stderr: format!("Connector command worker failed: {error}"),
                exit_code: Some(1),
                artifact: None,
            },
        };
        let succeeded = result.status == "completed";
        let message = CommandResultMessage {
            message_type: "command.result",
            command_id: envelope.command_id,
            sequence: envelope.sequence,
            status: result.status.clone(),
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exit_code,
            started_at: protocol_timestamp(started_at),
            completed_at: protocol_timestamp(completed_at),
            artifact: result.artifact,
        };
        if let Ok(value) = serde_json::to_value(message) {
            let _ = outbound.send(value);
        }
        self.set_phase(ConnectionPhase::Online, None);
        self.add_activity(
            "command",
            if succeeded {
                "Command completed"
            } else {
                "Command failed"
            },
            envelope.action,
            Some(succeeded),
        );
    }
}

fn normalize_api_base_url(value: &str) -> Result<String, String> {
    let mut url =
        Url::parse(value.trim()).map_err(|error| format!("Termes URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Termes URL must use http or https".to_owned());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Termes URL must include a host".to_owned())?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if url.scheme() != "https" && !loopback {
        return Err("Remote Termes connections require HTTPS".to_owned());
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn websocket_url(settings: &ConnectorSettings) -> Result<Url, String> {
    let mut url = Url::parse(&settings.api_base_url)
        .map_err(|error| format!("Stored Termes URL is invalid: {error}"))?;
    url.set_scheme(match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => return Err("Stored Termes URL has an unsupported scheme".to_owned()),
    })
    .map_err(|_| "Cannot convert the Termes URL to WebSocket".to_owned())?;
    url.set_path("/api/desktop-connectors/connect");
    url.set_query(Some(&format!("connectorId={}", settings.connector_id)));
    Ok(url)
}

fn api_error(body: &str, fallback: String) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or(fallback)
}

fn protocol_timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn send_ack(
    outbound: &mpsc::UnboundedSender<Value>,
    envelope: &CommandEnvelope,
    accepted: bool,
    reason: Option<&str>,
) {
    let _ = outbound.send(json!({
        "type": "command.ack",
        "commandId": envelope.command_id,
        "sequence": envelope.sequence,
        "accepted": accepted,
        "reason": reason,
        "acknowledgedAt": protocol_timestamp(Utc::now()),
    }));
}

fn redact_params(action: &str, params: &Value) -> Value {
    if action.ends_with(".input.type") {
        return json!({
            "text": "[REDACTED]",
            "characterCount": params.get("text").and_then(Value::as_str).map(|value| value.chars().count()).unwrap_or(0),
        });
    }
    params.clone()
}

fn command_request_hash(envelope: &CommandEnvelope) -> String {
    let command_id = serde_json::to_string(&envelope.command_id).unwrap_or_default();
    let action = serde_json::to_string(&envelope.action).unwrap_or_default();
    let params = serde_json::to_string(&envelope.params).unwrap_or_else(|_| "null".to_owned());
    let canonical = format!(
        "{{\"commandId\":{command_id},\"sequence\":{},\"action\":{action},\"params\":{params}}}",
        envelope.sequence,
    );
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_api_requires_tls() {
        assert!(normalize_api_base_url("http://example.com").is_err());
        assert_eq!(
            normalize_api_base_url("http://127.0.0.1:8080/").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            normalize_api_base_url("https://termes.example/path?q=1").unwrap(),
            "https://termes.example"
        );
    }

    #[test]
    fn typing_text_is_redacted_from_approval_payload() {
        let value = redact_params("macos.input.type", &json!({ "text": "top secret" }));
        assert_eq!(
            value.get("text").and_then(Value::as_str),
            Some("[REDACTED]")
        );
        assert_eq!(
            value.get("characterCount").and_then(Value::as_u64),
            Some(10)
        );
    }

    #[test]
    fn protocol_timestamps_use_the_rfc3339_utc_designator() {
        let timestamp = protocol_timestamp(Utc::now());
        assert!(timestamp.ends_with('Z'));
        assert!(!timestamp.contains("+00:00"));
    }

    #[test]
    fn command_hash_matches_server_outer_key_order() {
        let envelope = CommandEnvelope {
            protocol_version: PROTOCOL_VERSION,
            command_id: "123e4567-e89b-12d3-a456-426614174000".to_owned(),
            sequence: 3,
            action: "macos.system.info".to_owned(),
            params: json!({ "depth": 2 }),
            deadline: Utc::now().to_rfc3339(),
            request_hash: String::new(),
        };
        let expected = hex::encode(Sha256::digest(
            b"{\"commandId\":\"123e4567-e89b-12d3-a456-426614174000\",\"sequence\":3,\"action\":\"macos.system.info\",\"params\":{\"depth\":2}}",
        ));
        assert_eq!(command_request_hash(&envelope), expected);
    }
}
