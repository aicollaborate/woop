mod commands;
mod state;
mod sync;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            app.manage(state::MobileState::new(data_dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::mobile_initialize,
            commands::mobile_bootstrap_cloud,
            commands::cloud_get_state,
            commands::cloud_login,
            commands::cloud_logout,
            commands::mobile_reset_cloud_binding,
            commands::cloud_refresh_membership,
            commands::cloud_sync_now,
            commands::get_notebooks,
            commands::mobile_create_notebook,
            commands::mobile_rename_notebook,
            commands::set_current_notebook,
            commands::get_all_tags,
            commands::get_memos,
            commands::get_used_memo_tag_ids,
            commands::read_memo,
            commands::open_memo_session,
            commands::read_document,
            commands::write_document,
            commands::add_document,
            commands::delete_memo,
            commands::favorite_memo,
            commands::unfavorite_memo,
            commands::mobile_save_attachment_content,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Flowix Mobile");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Resumed) {
            sync::schedule_sync(app_handle.clone());
        }
    });
}
