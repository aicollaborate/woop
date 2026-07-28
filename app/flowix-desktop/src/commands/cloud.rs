use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use flowix_core::memo_file::{
    atomic_write_bytes, extract_frontmatter_key, merge_frontmatter, resolve_filename_conflict,
    sanitize_filename_component, IsMd, MergeOverrides,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    pub notebook_id: String,
    pub run_id: String,
    pub state: String,
    pub phase: String,
    pub uploaded: usize,
    pub deleted: usize,
    pub downloaded: usize,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
}

impl CloudSyncStatus {
    fn new(notebook_id: &str, run_id: &str, state: &str, phase: &str, started_at: i64) -> Self {
        Self {
            notebook_id: notebook_id.to_string(),
            run_id: run_id.to_string(),
            state: state.to_string(),
            phase: phase.to_string(),
            uploaded: 0,
            deleted: 0,
            downloaded: 0,
            started_at,
            finished_at: None,
            last_error: None,
        }
    }
}

fn sync_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn emit_sync_status(app: &AppHandle, status: &CloudSyncStatus) {
    let _ = app.emit("cloud-sync-status-changed", status);
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
    report: &mut SyncReport,
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

    for remote in &mut report.remote {
        match &mut remote.kind {
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
                *content = stamped_content;
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

fn canonicalize_local_keys(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let base = PathBuf::from(&notebook.path);
    let memos = memo_file.read_all_memos_for_notebook_id(Some(notebook_id));
    let mut disk_keys = HashMap::<String, String>::new();

    for memo in memos {
        let path = base.join(&memo.filename);
        let content = std::fs::read_to_string(&path)
            .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
        if let Some(disk_key) = extract_frontmatter_key(&content) {
            if let Some(existing_id) = disk_keys.insert(disk_key.clone(), memo.id.clone()) {
                if existing_id != memo.id {
                    return Err(format!(
                        "DUPLICATE_NOTE_KEY: key {disk_key} is used by {existing_id} and {}",
                        memo.id
                    ));
                }
            }
        }
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let canonical = merge_frontmatter(&content, &overrides);
        if canonical != content {
            crate::watcher::runtime::mark_self_write_for(app, &path);
            atomic_write_bytes(&path, canonical.as_bytes()).map_err(sync_error)?;
        }
    }
    Ok(())
}

static NOTEBOOK_SYNC_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();
static RECONCILED_NOTEBOOKS: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
const FULL_RECONCILE_INTERVAL_MS: i64 = 24 * 60 * 60 * 1_000;

fn notebook_sync_lock(notebook_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = NOTEBOOK_SYNC_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(notebook_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn notebook_reconciliation_key(link: &NotebookLink) -> String {
    format!(
        "{}:{}:{}",
        link.workspace_id, link.local_notebook_id, link.cloud_notebook_id
    )
}

fn notebook_was_reconciled(link: &NotebookLink) -> bool {
    let last_reconciled = RECONCILED_NOTEBOOKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&notebook_reconciliation_key(link))
        .copied();
    last_reconciled.is_some_and(|timestamp| {
        chrono::Utc::now().timestamp_millis() - timestamp < FULL_RECONCILE_INTERVAL_MS
    })
}

fn mark_notebook_reconciled(link: &NotebookLink) {
    RECONCILED_NOTEBOOKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            notebook_reconciliation_key(link),
            chrono::Utc::now().timestamp_millis(),
        );
}

async fn sync_one_inner(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
    run_id: &str,
    started_at: i64,
) -> Result<SyncReport, String> {
    let initial_link = state
        .cloud_sync
        .notebook_link(notebook_id)
        .map_err(sync_error)?
        .filter(|link| link.enabled)
        .ok_or_else(|| "NOTEBOOK_SYNC_DISABLED".to_string())?;
    if notebook_was_reconciled(&initial_link) {
        let needs_sync = state
            .cloud_sync
            .notebook_needs_sync(notebook_id)
            .await
            .map_err(sync_error)?;
        persist_rotated_token(state)?;
        if !needs_sync {
            return Ok(SyncReport {
                workspace_id: initial_link.workspace_id.clone(),
                started_at,
                cursor: initial_link.last_cursor,
                ..SyncReport::default()
            });
        }
    }
    canonicalize_local_keys(state, app, notebook_id)?;
    let notes = local_snapshot(state, notebook_id)?;
    emit_sync_status(
        app,
        &CloudSyncStatus::new(notebook_id, run_id, "syncing", "transfer", started_at),
    );
    let report_result = state.cloud_sync.sync_notebook(notebook_id, notes).await;
    persist_rotated_token(state)?;
    let mut report = report_result.map_err(sync_error)?;
    let active_link = state
        .cloud_sync
        .notebook_link(notebook_id)
        .map_err(sync_error)?;
    if active_link.as_ref() != Some(&initial_link)
        || report.workspace_id != initial_link.workspace_id
    {
        return Err("CLOUD_NOTEBOOK_LINK_CHANGED_DURING_SYNC".to_string());
    }
    emit_sync_status(
        app,
        &CloudSyncStatus::new(notebook_id, run_id, "finalizing", "apply", started_at),
    );
    apply_report(state, app, notebook_id, &mut report)?;
    canonicalize_local_keys(state, app, notebook_id)?;
    state
        .cloud_sync
        .complete_sync(notebook_id, &report)
        .map_err(sync_error)?;
    mark_notebook_reconciled(&initial_link);
    Ok(report)
}

async fn sync_one(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
) -> Result<SyncReport, String> {
    let sync_lock = notebook_sync_lock(notebook_id);
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now().timestamp_millis();
    if sync_lock.try_lock().is_err() {
        emit_sync_status(
            app,
            &CloudSyncStatus::new(notebook_id, &run_id, "queued", "waiting", started_at),
        );
    }
    let _guard = sync_lock.lock().await;
    emit_sync_status(
        app,
        &CloudSyncStatus::new(notebook_id, &run_id, "checking", "snapshot", started_at),
    );
    match sync_one_inner(state, app, notebook_id, &run_id, started_at).await {
        Ok(report) => {
            let mut status =
                CloudSyncStatus::new(notebook_id, &run_id, "success", "complete", started_at);
            status.uploaded = report.uploaded;
            status.deleted = report.deleted;
            status.downloaded = report.remote.len();
            status.finished_at = Some(chrono::Utc::now().timestamp_millis());
            emit_sync_status(app, &status);

            let app = app.clone();
            let notebook_id = notebook_id.to_string();
            let run_id = run_id.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1_200)).await;
                let mut idle =
                    CloudSyncStatus::new(&notebook_id, &run_id, "idle", "idle", started_at);
                idle.finished_at = Some(chrono::Utc::now().timestamp_millis());
                emit_sync_status(&app, &idle);
            });
            Ok(report)
        }
        Err(error) => {
            let mut status =
                CloudSyncStatus::new(notebook_id, &run_id, "error", "failed", started_at);
            status.finished_at = Some(chrono::Utc::now().timestamp_millis());
            status.last_error = Some(error.clone());
            emit_sync_status(app, &status);
            Err(error)
        }
    }
}

static SYNC_GENERATIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static POLLING_STARTED: AtomicBool = AtomicBool::new(false);

/// Debounce editor/watcher bursts and run synchronization off the write path.
pub(crate) fn schedule_notebook_sync(app: AppHandle, notebook_id: String) {
    schedule_notebook_sync_after(app, notebook_id, Duration::from_millis(1_200));
}

fn schedule_notebook_sync_after(app: AppHandle, notebook_id: String, delay: Duration) {
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
        tokio::time::sleep(delay).await;
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
                .unwrap_or(false)
            && state
                .cloud_sync
                .automatic_sync_due(&notebook_id, chrono::Utc::now().timestamp_millis())
                .unwrap_or(false);
        if should_sync {
            if let Err(error) = sync_one(state.inner(), &app, &notebook_id).await {
                tracing::warn!("automatic cloud sync failed for {notebook_id}: {error}");
                schedule_retry_after_failure(&app, &notebook_id);
            }
        }
    });
}

fn schedule_retry_after_failure(app: &AppHandle, notebook_id: &str) {
    let state = app.state::<AppState>();
    match state.cloud_sync.defer_notebook_retry(notebook_id) {
        Ok(Some(delay_ms)) => schedule_notebook_sync_after(
            app.clone(),
            notebook_id.to_string(),
            Duration::from_millis(delay_ms.max(1) as u64),
        ),
        Ok(None) => {}
        Err(error) => {
            tracing::warn!("failed to schedule cloud retry for {notebook_id}: {error}");
        }
    }
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
                if !state
                    .cloud_sync
                    .automatic_sync_due(&notebook_id, chrono::Utc::now().timestamp_millis())
                    .unwrap_or(false)
                {
                    continue;
                }
                if let Err(error) = sync_one(state.inner(), &app, &notebook_id).await {
                    tracing::warn!("periodic cloud sync failed for {notebook_id}: {error}");
                    schedule_retry_after_failure(&app, &notebook_id);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notebook_sync_lock_is_shared_per_notebook() {
        let first = notebook_sync_lock("sync-lock-notebook-a");
        let same = notebook_sync_lock("sync-lock-notebook-a");
        let other = notebook_sync_lock("sync-lock-notebook-b");

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &other));
    }

    #[test]
    fn cloud_sync_status_uses_camel_case_wire_format() {
        let mut status =
            CloudSyncStatus::new("nb_1", "run_1", "error", "failed", 1_700_000_000_000);
        status.finished_at = Some(1_700_000_000_100);
        status.last_error = Some("network unavailable".to_string());

        let value = serde_json::to_value(status).expect("serialize cloud sync status");
        assert_eq!(value["notebookId"], "nb_1");
        assert_eq!(value["runId"], "run_1");
        assert_eq!(value["startedAt"], 1_700_000_000_000_i64);
        assert_eq!(value["finishedAt"], 1_700_000_000_100_i64);
        assert_eq!(value["lastError"], "network unavailable");
    }
}
