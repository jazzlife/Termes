mod connector;
mod model;
mod platform;
mod storage;

use connector::ConnectorState;
use model::{ConnectorSnapshot, PairInput};
use std::sync::Arc;
use tauri::{Manager, State};

#[tauri::command]
fn get_connector_snapshot(state: State<'_, Arc<ConnectorState>>) -> ConnectorSnapshot {
    state.snapshot()
}

#[tauri::command]
fn get_default_device_name() -> String {
    storage::default_device_name()
}

#[tauri::command]
async fn pair_connector(
    state: State<'_, Arc<ConnectorState>>,
    input: PairInput,
) -> Result<ConnectorSnapshot, String> {
    state.inner().pair(input).await
}

#[tauri::command]
async fn connect_connector(state: State<'_, Arc<ConnectorState>>) -> Result<(), String> {
    state.inner().connect().await
}

#[tauri::command]
async fn disconnect_connector(
    state: State<'_, Arc<ConnectorState>>,
) -> Result<ConnectorSnapshot, String> {
    Ok(state.inner().disconnect().await)
}

#[tauri::command]
async fn forget_connector(
    state: State<'_, Arc<ConnectorState>>,
) -> Result<ConnectorSnapshot, String> {
    state.inner().forget().await
}

#[tauri::command]
async fn set_auto_observe(
    state: State<'_, Arc<ConnectorState>>,
    enabled: bool,
) -> Result<ConnectorSnapshot, String> {
    state.inner().set_auto_observe(enabled).await
}

#[tauri::command]
async fn approve_connector_command(
    state: State<'_, Arc<ConnectorState>>,
    command_id: String,
) -> Result<(), String> {
    state.inner().resolve_approval(&command_id, true).await
}

#[tauri::command]
async fn reject_connector_command(
    state: State<'_, Arc<ConnectorState>>,
    command_id: String,
) -> Result<(), String> {
    state.inner().resolve_approval(&command_id, false).await
}

#[tauri::command]
async fn emergency_stop_connector(
    state: State<'_, Arc<ConnectorState>>,
) -> Result<ConnectorSnapshot, String> {
    Ok(state.inner().emergency_stop().await)
}

#[tauri::command]
fn refresh_connector_permissions(state: State<'_, Arc<ConnectorState>>) -> ConnectorSnapshot {
    state.snapshot()
}

#[tauri::command]
fn open_connector_permission_settings(kind: String) -> Result<(), String> {
    platform::open_permission_settings(&kind)
}

#[tauri::command]
fn request_connector_permission(kind: String) -> Result<(), String> {
    platform::request_permission(&kind)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = ConnectorState::new(app.handle().clone())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_connector_snapshot,
            get_default_device_name,
            pair_connector,
            connect_connector,
            disconnect_connector,
            forget_connector,
            set_auto_observe,
            approve_connector_command,
            reject_connector_command,
            emergency_stop_connector,
            refresh_connector_permissions,
            request_connector_permission,
            open_connector_permission_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Termes Connector");
}
