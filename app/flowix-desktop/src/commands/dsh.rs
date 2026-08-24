//! DSH Runtime installation and Flowix plugin integration commands.

use crate::app::state::AppState;
use crate::events as dispatcher;
use tauri::State;

pub const DSH_RUNTIME_STATUS_CHANGED_EVENT: &str = "dsh-runtime-status-changed";

fn emit_runtime_status(app: &tauri::AppHandle, status: &crate::dsh::DshStatus) {
    let _ = dispatcher::emit_to(app, DSH_RUNTIME_STATUS_CHANGED_EVENT, status);
}

#[tauri::command]
pub fn dsh_status() -> crate::dsh::DshStatus {
    crate::dsh::status()
}

#[tauri::command]
pub async fn dsh_archive_size() -> Option<u64> {
    tauri::async_runtime::spawn_blocking(crate::dsh::latest_archive_size)
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub fn dsh_download_status() -> Option<crate::dsh::DshDownloadProgress> {
    crate::dsh::download_progress()
}

#[tauri::command]
pub async fn dsh_install_runtime(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::dsh::DshStatus, String> {
    ensure_runtime_replaceable(&state).await?;
    let manager = state.deepseek_harness.clone();
    let install_app = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        crate::dsh::install_runtime_with_progress_before_publish(Some(install_app), move || {
            tauri::async_runtime::block_on(manager.invalidate_hosts())
                .map_err(|error| format!("stop DeepSeek Harness before install: {error}"))
        })
    })
    .await
    .map_err(|error| format!("DSH installer task failed: {error}"))??;
    emit_runtime_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub async fn dsh_update(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::dsh::DshStatus, String> {
    ensure_runtime_replaceable(&state).await?;
    let manager = state.deepseek_harness.clone();
    let update_app = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        crate::dsh::install_runtime_with_progress_before_publish(Some(update_app), move || {
            tauri::async_runtime::block_on(manager.invalidate_hosts())
                .map_err(|error| format!("stop DeepSeek Harness before update: {error}"))
        })
    })
    .await
    .map_err(|error| format!("DSH updater task failed: {error}"))??;
    emit_runtime_status(&app, &status);
    Ok(status)
}

/// Start or resume the managed runtime installation/update through one
/// command shared by the main window and Preferences.
#[tauri::command]
pub async fn dsh_ensure_runtime(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::dsh::DshStatus, String> {
    ensure_runtime_replaceable(&state).await?;
    let manager = state.deepseek_harness.clone();
    let ensure_app = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        crate::dsh::install_runtime_with_progress_before_publish(Some(ensure_app), move || {
            tauri::async_runtime::block_on(manager.invalidate_hosts())
                .map_err(|error| format!("stop DeepSeek Harness before install/update: {error}"))
        })
    })
    .await
    .map_err(|error| format!("DSH ensure task failed: {error}"))??;
    emit_runtime_status(&app, &status);
    Ok(status)
}

async fn ensure_runtime_replaceable(state: &State<'_, AppState>) -> Result<(), String> {
    if crate::dsh::status().installed {
        state
            .deepseek_harness
            .ensure_hosts_replaceable()
            .await
            .map_err(|error| format!("prepare DeepSeek Harness install/update: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn dsh_cancel_update() -> bool {
    crate::dsh::cancel_update();
    true
}

/// Shut down every running dsh-host, then remove the managed runtime tree.
/// User state under `~/.dsh` (settings, sessions) is preserved; reinstalling
/// from the Runtime tab restores a clean runtime.
#[tauri::command]
pub async fn dsh_uninstall(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::dsh::DshStatus, String> {
    state
        .deepseek_harness
        .prepare_uninstall()
        .await
        .map_err(|error| format!("stop DeepSeek Harness before uninstall: {error}"))?;
    let status = tauri::async_runtime::spawn_blocking(crate::dsh::uninstall_runtime)
        .await
        .map_err(|error| format!("DSH uninstall task failed: {error}"))??;
    emit_runtime_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub async fn dsh_manage_profile_plugin(
    action: String,
    package: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.deepseek_harness.invalidate_hosts().await?;
    // Materialize the Flowix-owned profile bundles before the official CLI
    // sees this profile. Otherwise upstream initializes an unknown profile
    // without the Flowix bridge and independent memory bundle.
    state.deepseek_harness.plugin_catalog().await?;
    state.deepseek_harness.invalidate_hosts().await?;
    let dsh_home = state.user_config.dsh_dir();
    tauri::async_runtime::spawn_blocking(move || {
        crate::dsh::run_profile_plugin(&dsh_home, &action, package.as_deref())
    })
    .await
    .map_err(|error| format!("DSH plugin task failed: {error}"))?
}
