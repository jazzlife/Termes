mod connector;
mod model;
mod platform;
mod storage;

use connector::ConnectorState;
use model::{ConnectorSnapshot, PairInput};
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime, State, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_QUIT_ID: &str = "tray-quit";

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

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
    let app = tauri::Builder::default()
        .setup(|app| {
            platform::cleanup_stale_development_sources()?;
            let state = ConnectorState::new(app.handle().clone())?;
            state.connect_on_startup();
            app.manage(state);

            #[cfg(target_os = "macos")]
            app.handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)?;

            let show_item = MenuItem::with_id(
                app,
                TRAY_SHOW_ID,
                "Termes Connector 열기",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "종료", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut tray = TrayIconBuilder::with_id("termes-connector")
                .tooltip("Termes Connector")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .icon_as_template(cfg!(target_os = "macos"))
                .on_menu_event(|app, event| match event.id().as_ref() {
                    TRAY_SHOW_ID => show_main_window(app),
                    TRAY_QUIT_ID => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            #[cfg(target_os = "macos")]
            {
                let icon =
                    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
                tray = tray.icon(icon);
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
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
        .build(tauri::generate_context!())
        .expect("error while building Termes Connector");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main_window(app);
        }
    });
}
