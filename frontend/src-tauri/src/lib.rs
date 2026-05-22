use tauri::Manager;

mod discovery;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(discovery::DiscoveryState::new())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            discovery::tauri_start_discovery,
            discovery::tauri_stop_discovery,
            discovery::tauri_broadcast_room_share,
            discovery::tauri_stop_room_share,
            discovery::tauri_send_connection_request,
            discovery::tauri_approve_connection,
            discovery::tauri_send_local_signal,
            discovery::tauri_get_my_uuid
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
