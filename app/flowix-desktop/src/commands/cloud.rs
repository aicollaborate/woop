use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use flowix_core::memo_file::{
    atomic_write_bytes, merge_frontmatter, resolve_filename_conflict, sanitize_filename_component,
    IsMd, MergeOverrides,
};
use flowix_sync::{
    CloudCheckout, CloudMembership, CloudNotebook, CloudProduct, CloudState, LocalNote,
    NotebookLink, RemoteApplyKind, SyncReport,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::app::state::AppState;
use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    pub notebooks: usize,
    pub uploaded: usize,
    pub deleted: usize,
    pub downloaded: usize,
}

fn sync_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn emit_cloud_state(app: &AppHandle, state: &CloudState) {
    let _ = app.emit("cloud-state-changed", state);
}

fn persist_rotated_token(state: &AppState) -> Result<(), String> {
    if let Some(token) = state.cloud_sync.current_refresh_token() {
        state
            .user_config
            .save_cloud_refresh_token(&token)
            .map_err(sync_error)?;
    }
    Ok(())
}

fn local_snapshot(state: &AppState, notebook_id: &str) -> Result<Vec<LocalNote>, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let memos = memo_file.read_all_memos_for_notebook_id(Some(notebook_id));
    drop(memo_file);

    memos
        .into_iter()
        .map(|memo| {
            let path = PathBuf::from(&notebook.path).join(&memo.filename);
            let content = std::fs::read_to_string(&path)
                .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
            Ok(LocalNote {
                id: memo.id,
                filename: memo.filename,
                content,
                updated_at: memo.updated_at,
            })
        })
        .collect()
}

fn safe_cloud_note_path(base: &Path, filename: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(filename);
    if candidate.file_name().and_then(|value| value.to_str()) != Some(filename)
        || !candidate.is_md()
    {
        return Err("INVALID_CLOUD_FILENAME".to_string());
    }
    Ok(base.join(filename))
}

fn apply_report(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
    report: &SyncReport,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let base = PathBuf::from(&notebook.path);
    let mut occupied: Vec<String> = memo_file
        .read_all_memos_for_notebook_id(Some(notebook_id))
        .into_iter()
        .map(|memo| memo.filename)
        .collect();

    for remote in &report.remote {
        match &remote.kind {
            RemoteApplyKind::Delete => {
                if let Some(memo) =
                    memo_file.read_memo_for_notebook_id(notebook_id, &remote.note_id)
                {
                    let path = base.join(&memo.filename);
                    crate::watcher::runtime::mark_self_write_for(app, &path);
                    let derived_changed = MemoDerivedChanged::from_deleted(&memo);
                    if memo_file
                        .delete_memo_result_for_notebook_id(notebook_id, &remote.note_id)
                        .map_err(sync_error)?
                    {
                        memo_events::emit(
                            app,
                            MemoEvent::Deleted {
                                id: remote.note_id.clone(),
                                path: path.to_string_lossy().into_owned(),
                                notebook_id: notebook_id.to_string(),
                                derived_changed,
                                source: MemoChangeSource::CloudSync,
                            },
                        );
                    }
                }
            }
            RemoteApplyKind::Upsert {
                filename, content, ..
            } => {
                let current_memo =
                    memo_file.read_memo_for_notebook_id(notebook_id, &remote.note_id);
                if current_memo.is_none() {
                    if let Some(location) = memo_file
                        .resolve_memo_location(&remote.note_id)
                        .map_err(sync_error)?
                    {
                        return Err(format!(
                            "CLOUD_NOTE_ID_COLLISION: note {} belongs to local notebook {}",
                            remote.note_id, location.notebook.id
                        ));
                    }
                }
                let old_path = current_memo.as_ref().map(|memo| base.join(&memo.filename));
                let mut desired_path = safe_cloud_note_path(&base, filename)?;
                if desired_path.exists() && old_path.as_ref() != Some(&desired_path) {
                    let title = Path::new(filename)
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Cloud note");
                    let safe_title = sanitize_filename_component(&format!("{title} (Cloud)"));
                    let safe_filename = resolve_filename_conflict(&base, &safe_title, &occupied);
                    desired_path = base.join(&safe_filename);
                    occupied.push(safe_filename);
                }
                crate::watcher::runtime::mark_self_write_for(app, &desired_path);
                if let Some(path) = &old_path {
                    crate::watcher::runtime::mark_self_write_for(app, path);
                }
                let overrides: MergeOverrides = [("key".to_string(), remote.note_id.clone())]
                    .into_iter()
                    .collect();
                let stamped_content = merge_frontmatter(content, &overrides);
                atomic_write_bytes(&desired_path, stamped_content.as_bytes())
                    .map_err(sync_error)?;
                let memo = memo_file
                    .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                    .map_err(sync_error)?;
                if memo.id != remote.note_id {
                    return Err(format!(
                        "CLOUD_NOTE_ID_MISMATCH: expected {}, registered {}",
                        remote.note_id, memo.id
                    ));
                }
                if let Some(path) = old_path.filter(|path| path != &desired_path) {
                    if path.exists() {
                        std::fs::remove_file(&path).map_err(sync_error)?;
                    }
                }
                memo_events::emit(
                    app,
                    MemoEvent::Updated {
                        id: memo.id.clone(),
                        path: desired_path.to_string_lossy().into_owned(),
                        notebook_id: notebook_id.to_string(),
                        derived_changed: MemoDerivedChanged {
                            tags: true,
                            todos: true,
                            agents: true,
                        },
                        memo,
                        source: MemoChangeSource::CloudSync,
                    },
                );
            }
        }
    }
    Ok(())
}

async fn sync_one(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
) -> Result<SyncReport, String> {
    let notes = local_snapshot(state, notebook_id)?;
    let report_result = state.cloud_sync.sync_notebook(notebook_id, notes).await;
    persist_rotated_token(state)?;
    let report = report_result.map_err(sync_error)?;
    let active_workspace = state
        .cloud_sync
        .notebook_link(notebook_id)
        .map_err(sync_error)?
        .map(|link| link.workspace_id);
    if active_workspace.as_deref() != Some(report.workspace_id.as_str()) {
        return Err("CLOUD_ACCOUNT_CHANGED_DURING_SYNC".to_string());
    }
    apply_report(state, app, notebook_id, &report)?;
    state
        .cloud_sync
        .complete_sync(notebook_id, &report)
        .map_err(sync_error)?;
    Ok(report)
}

static SYNC_GENERATIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static POLLING_STARTED: AtomicBool = AtomicBool::new(false);

/// Debounce editor/watcher bursts and run synchronization off the write path.
pub(crate) fn schedule_notebook_sync(app: AppHandle, notebook_id: String) {
    let generation = {
        let generations = SYNC_GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut values = generations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next = values.get(&notebook_id).copied().unwrap_or(0) + 1;
        values.insert(notebook_id.clone(), next);
        next
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        let is_latest = SYNC_GENERATIONS
            .get()
            .and_then(|generations| generations.lock().ok())
            .and_then(|values| values.get(&notebook_id).copied())
            == Some(generation);
        if !is_latest {
            return;
        }
        let state = app.state::<AppState>();
        let should_sync = state
            .cloud_sync
            .state()
            .map(|cloud| cloud.enabled && cloud.authenticated)
            .unwrap_or(false)
            && state
                .cloud_sync
                .notebook_link(&notebook_id)
                .ok()
                .flatten()
                .map(|link| link.enabled)
                .unwrap_or(false);
        if should_sync {
            if let Err(error) = sync_one(state.inner(), &app, &notebook_id).await {
                tracing::warn!("automatic cloud sync failed for {notebook_id}: {error}");
            }
        }
    });
}

pub(crate) fn start_cloud_sync_polling(app: AppHandle) {
    if POLLING_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let notebook_ids = {
                let state = app.state::<AppState>();
                let cloud_state = state.cloud_sync.state().ok();
                if !matches!(
                    cloud_state,
                    Some(CloudState {
                        enabled: true,
                        authenticated: true,
                        ..
                    })
                ) {
                    Vec::new()
                } else {
                    state
                        .cloud_sync
                        .enabled_notebooks()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|link| link.local_notebook_id)
                        .collect()
                }
            };
            for notebook_id in notebook_ids {
                let state = app.state::<AppState>();
                if let Err(error) = sync_one(state.inner(), &app, &notebook_id).await {
                    tracing::warn!("periodic cloud sync failed for {notebook_id}: {error}");
                }
            }
        }
    });
}

#[tauri::command]
pub fn cloud_get_state(state: State<AppState>) -> Result<CloudState, String> {
    state.cloud_sync.state().map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_register(
    email: String,
    password: String,
    display_name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let outcome = state
        .cloud_sync
        .register(email.trim(), &password, display_name.trim())
        .await
        .map_err(sync_error)?;
    state
        .user_config
        .save_cloud_refresh_token(&outcome.refresh_token)
        .map_err(sync_error)?;
    emit_cloud_state(&app, &outcome.state);
    Ok(outcome.state)
}

#[tauri::command]
pub async fn cloud_login(
    email: String,
    password: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let outcome = state
        .cloud_sync
        .login(email.trim(), &password)
        .await
        .map_err(sync_error)?;
    state
        .user_config
        .save_cloud_refresh_token(&outcome.refresh_token)
        .map_err(sync_error)?;
    emit_cloud_state(&app, &outcome.state);
    Ok(outcome.state)
}

#[tauri::command]
pub async fn cloud_sign_in_with_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    let outcome = state
        .cloud_sync
        .sign_in_with_apple(&authorization)
        .await
        .map_err(sync_error)?;
    state
        .user_config
        .save_cloud_refresh_token(&outcome.refresh_token)
        .map_err(sync_error)?;
    emit_cloud_state(&app, &outcome.state);
    Ok(outcome.state)
}

#[tauri::command]
pub async fn cloud_link_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    let next_state = state
        .cloud_sync
        .link_apple(&authorization)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_logout(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    state.cloud_sync.logout().await.map_err(sync_error)?;
    state
        .user_config
        .delete_cloud_refresh_token()
        .map_err(sync_error)?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub fn cloud_set_enabled(
    enabled: bool,
    state: State<AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let next_state = state.cloud_sync.set_enabled(enabled).map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub fn cloud_get_notebook_state(
    notebook_id: String,
    state: State<AppState>,
) -> Result<Option<NotebookLink>, String> {
    state
        .cloud_sync
        .notebook_link(&notebook_id)
        .map_err(sync_error)
}

#[tauri::command]
pub fn cloud_list_notebook_states(state: State<AppState>) -> Result<Vec<NotebookLink>, String> {
    state.cloud_sync.enabled_notebooks().map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_notebooks(
    state: State<'_, AppState>,
) -> Result<Vec<CloudNotebook>, String> {
    let notebooks_result = state.cloud_sync.remote_notebooks().await;
    persist_rotated_token(state.inner())?;
    notebooks_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_link_notebook(
    notebook_id: String,
    cloud_notebook_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<NotebookLink, String> {
    let link_result = state
        .cloud_sync
        .link_remote_notebook(&notebook_id, &cloud_notebook_id)
        .await;
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(sync_error)?;
    if let Ok(next_state) = state.cloud_sync.state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(link)
}

#[tauri::command]
pub async fn cloud_set_notebook_enabled(
    notebook_id: String,
    enabled: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<NotebookLink, String> {
    let notebook_name = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?
        .name;
    let link_result = state
        .cloud_sync
        .set_notebook_enabled(&notebook_id, &notebook_name, enabled)
        .await;
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(sync_error)?;
    if let Ok(next_state) = state.cloud_sync.state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(link)
}

#[tauri::command]
pub async fn cloud_refresh_membership(
    state: State<'_, AppState>,
) -> Result<CloudMembership, String> {
    let membership_result = state.cloud_sync.refresh_membership().await;
    persist_rotated_token(state.inner())?;
    membership_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_products(state: State<'_, AppState>) -> Result<Vec<CloudProduct>, String> {
    state.cloud_sync.products().await.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_create_checkout(
    product_id: String,
    state: State<'_, AppState>,
) -> Result<CloudCheckout, String> {
    let idempotency_key = format!("desktop-{}", uuid::Uuid::new_v4());
    let checkout_result = state
        .cloud_sync
        .create_checkout(&product_id, &idempotency_key)
        .await;
    persist_rotated_token(state.inner())?;
    checkout_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_sync_now(
    notebook_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    let notebook_ids = match notebook_id {
        Some(id) => vec![id],
        None => state
            .cloud_sync
            .enabled_notebooks()
            .map_err(sync_error)?
            .into_iter()
            .map(|link| link.local_notebook_id)
            .collect(),
    };
    let mut result = CloudSyncResult {
        notebooks: 0,
        uploaded: 0,
        deleted: 0,
        downloaded: 0,
    };
    for notebook_id in notebook_ids {
        let report = sync_one(state.inner(), &app, &notebook_id).await?;
        result.notebooks += 1;
        result.uploaded += report.uploaded;
        result.deleted += report.deleted;
        result.downloaded += report.remote.len();
    }
    Ok(result)
}
