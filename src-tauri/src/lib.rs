mod terminal;
mod presence;
mod whatsapp_bridge;

use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use terminal::TerminalState;
use whatsapp_bridge::WhatsAppBridgeState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(TerminalState::default()))
        .manage(WhatsAppBridgeState::default())
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_exec,
            terminal::terminal_kill,
            terminal::terminal_list_sessions,
            terminal::terminal_get_fs_info,
            terminal::terminal_get_status,
            terminal::terminal_reinstall_rootfs,
            presence::get_presence,
            whatsapp_bridge::whatsapp_bridge_start,
            whatsapp_bridge::whatsapp_bridge_stop,
            whatsapp_bridge::whatsapp_notify,
            whatsapp_bridge::whatsapp_status,
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
