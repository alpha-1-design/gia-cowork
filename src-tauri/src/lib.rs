mod terminal;
mod presence;
mod desktop_fs;
mod whatsapp_bridge;
mod screen;
mod unimind_relay;

use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use terminal::TerminalState;
use whatsapp_bridge::WhatsAppBridgeState;

#[derive(serde::Serialize)]
struct SystemInfo {
    total_ram_gb: f64,
    cpu_cores: u32,
}

#[tauri::command]
fn credential_get(service: String, account: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|e| format!("Credential entry error: {e}"))?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Credential read failed: {e}")),
    }
}

#[tauri::command]
fn credential_set(service: String, account: String, secret: String) -> Result<(), String> {
    if service.trim().is_empty() || account.trim().is_empty() {
        return Err("Credential service and account are required".into());
    }
    let entry = keyring::Entry::new(&service, &account).map_err(|e| format!("Credential entry error: {e}"))?;
    entry.set_password(&secret).map_err(|e| format!("Credential write failed: {e}"))
}

#[tauri::command]
fn credential_delete(service: String, account: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|e| format!("Credential entry error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Credential delete failed: {e}")),
    }
}

/// Temporarily hide the main window so screen captures don't include GIA.
/// Returns true if the window was hidden. The caller must invoke
/// `show_after_capture` when done.
#[tauri::command]
async fn hide_for_capture(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
        // Give the compositor a frame to redraw without the window
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Restore the main window after a capture-induced hide.
#[tauri::command]
async fn show_after_capture(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Quit the whole process (including the tray daemon). The window close
/// handler only hides to tray, so the updater cannot use window.close() to
/// fully exit after applying a release.
#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Real hardware report from the OS (not the browser-capped deviceMemory).
/// Reads /proc/meminfo on Linux; falls back to 0 so the caller can estimate.
#[tauri::command]
fn system_info() -> SystemInfo {
    let total_ram_gb: f64 = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|n| n.parse::<f64>().ok())
        })
        .map(|kb| kb / (1024.0 * 1024.0))
        .unwrap_or(0.0);

    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(0);

    SystemInfo { total_ram_gb, cpu_cores }
}

/// Status of the embedded Unimind relay (auto-started on boot). Used by the
/// frontend so the phone-pairing page can show the exact ws:// URLs to use.
#[derive(serde::Serialize)]
struct UnimindRelayInfo {
    running: bool,
    port: u16,
    ws_url: String,
    lan_url: Option<String>,
    secret_required: bool,
    lan_enabled: bool,
}

#[tauri::command]
fn unimind_relay_status() -> UnimindRelayInfo {
    let port = unimind_relay::relay_port();
    UnimindRelayInfo {
        running: unimind_relay::relay_running(),
        port,
        ws_url: format!("ws://127.0.0.1:{port}/unimind"),
        lan_url: if unimind_relay::relay_lan_enabled() {
            unimind_relay::local_lan_ip().map(|ip| format!("ws://{ip}:{port}/unimind"))
        } else {
            None
        },
        secret_required: !std::env::var("UNIMIND_RELAY_SECRET").unwrap_or_default().is_empty(),
        lan_enabled: unimind_relay::relay_lan_enabled(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(Arc::new(TerminalState::default()))
        .manage(WhatsAppBridgeState::default())
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_exec,
            terminal::terminal_kill,
            terminal::terminal_list_sessions,
            terminal::terminal_get_fs_info,
            terminal::terminal_get_status,
            terminal::terminal_reinstall_rootfs,
            desktop_fs::fs_read,
            desktop_fs::fs_write,
            desktop_fs::fs_write_bytes,
            desktop_fs::fs_list,
            presence::get_presence,
            screen::screen_capture,
            screen::screen_capture_area,
            screen::screen_tap,
            screen::screen_double_tap,
            screen::screen_right_tap,
            screen::screen_drag,
            screen::screen_type_text,
            screen::screen_key,
            screen::screen_scroll,
            hide_for_capture,
            show_after_capture,
            whatsapp_bridge::whatsapp_bridge_start,
            whatsapp_bridge::whatsapp_bridge_stop,
            whatsapp_bridge::whatsapp_notify,
            whatsapp_bridge::whatsapp_status,
            whatsapp_bridge::whatsapp_messages,
            whatsapp_bridge::whatsapp_contacts,
            app_exit,
            system_info,
            credential_get,
            credential_set,
            credential_delete,
            unimind_relay_status,
        ])
        .setup(|app| {
            // System tray so GIA Cowork can run as a background daemon,
            // not just a foreground window -- the "always-on" part of the
            // presence model needs the app alive when the window is closed.
            let show_item = MenuItem::with_id(app, "show", "Show GIA Cowork", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Closing the window hides it instead of quitting the process --
            // that's what makes this a background daemon rather than a
            // normal window-scoped app. Quit only happens via the tray menu.
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let _ = window_clone.hide();
                        api.prevent_close();
                    }
                });
            }

            // Embedded Unimind relay: run the cross-device wire for the whole
            // process lifetime with no Node.js dependency. Only on desktop —
            // the phone side does not run a relay. It dies with the process.
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let _ = tauri::async_runtime::spawn(async move {
                    unimind_relay::run_relay().await;
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
