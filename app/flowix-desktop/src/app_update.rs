use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex};

use futures::future::{AbortHandle, Abortable};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
pub struct AppUpdateState {
    active_download: Mutex<Option<AbortHandle>>,
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    {
        let active = state
            .active_download
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        if active.is_some() {
            return Err("an application update is already downloading".to_string());
        }
    }

    let updater = app
        .updater()
        .map_err(|error| format!("failed to initialize updater: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("failed to check for update: {error}"))?
        .ok_or_else(|| "no application update is available".to_string())?;

    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    {
        let mut active = state
            .active_download
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        if active.is_some() {
            return Err("an application update is already downloading".to_string());
        }
        *active = Some(abort_handle);
    }

    let download_app = app.clone();
    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let started = Arc::new(AtomicBool::new(false));
    let task = async move {
        let progress_bytes = downloaded_bytes.clone();
        let progress_started = started.clone();
        let bytes = update
            .download(
                |chunk_length, content_length| {
                    if !progress_started.swap(true, Ordering::Relaxed) {
                        let _ = download_app.emit(
                            "app-update-progress",
                            json!({
                                "phase": "started",
                                "contentLength": content_length,
                            }),
                        );
                    }
                    let downloaded = progress_bytes
                        .fetch_add(chunk_length as u64, Ordering::Relaxed)
                        + chunk_length as u64;
                    let _ = download_app.emit(
                        "app-update-progress",
                        json!({
                            "phase": "progress",
                            "downloadedBytes": downloaded,
                            "contentLength": content_length,
                        }),
                    );
                },
                || {
                    let _ = download_app.emit(
                        "app-update-progress",
                        json!({
                            "phase": "finished",
                            "downloadedBytes": progress_bytes.load(Ordering::Relaxed),
                        }),
                    );
                },
            )
            .await
            .map_err(|error| format!("failed to download update: {error}"))?;

        update
            .install(bytes)
            .map_err(|error| format!("failed to install update: {error}"))
    };

    let result = Abortable::new(task, abort_registration).await;
    if let Ok(mut active) = state.active_download.lock() {
        *active = None;
    }

    match result {
        Ok(result) => result,
        Err(_) => Err("application update cancelled".to_string()),
    }
}

#[tauri::command]
pub fn cancel_app_update(state: State<'_, AppUpdateState>) -> Result<bool, String> {
    let active = state
        .active_download
        .lock()
        .map_err(|_| "application update state is unavailable".to_string())?;
    if let Some(handle) = active.as_ref() {
        handle.abort();
        Ok(true)
    } else {
        Ok(false)
    }
}
