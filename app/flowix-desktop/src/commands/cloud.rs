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
    v2_content_hash, CloudCheckout, CloudMembership, CloudNotebook, CloudProduct, CloudState,
    collect_v2_attachments, SyncError, V2AccountSyncReport, V2LocalNote, V2LocalNotebook, V2RemoteApply, V2SyncedNotebook,
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

fn cloud_error(error: SyncError) -> String {
    match error {
        SyncError::Api { code, details, .. }
            if code == "MEMBERSHIP_REQUIRED" || code == "STORAGE_QUOTA_EXCEEDED" =>
        {
            format!("{code}:{}", details.unwrap_or(serde_json::Value::Null))
        }
        other => other.to_string(),
    }
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

fn v2_account_snapshot(
    state: &AppState,
) -> Result<(Vec<V2LocalNotebook>, Vec<V2LocalNote>), String> {
    let enabled: std::collections::HashSet<String> = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?
        .into_iter()
        .map(|notebook| notebook.notebook_id)
        .collect();
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let configs = memo_file.read_notebook_configs().map_err(sync_error)?;
    let mut notebooks = Vec::new();
    let mut notes = Vec::new();
    for config in configs
        .into_iter()
        .filter(|config| enabled.contains(&config.id))
    {
        for memo in memo_file.read_all_memos_for_notebook_id(Some(&config.id)) {
            let path = PathBuf::from(&config.path).join(&memo.filename);
            let content = std::fs::read(&path)
                .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
            let attachments = collect_v2_attachments(
                &PathBuf::from(&config.path).join("attachments"),
                &content,
            )?;
            notes.push(V2LocalNote {
                id: memo.id,
                notebook_id: config.id.clone(),
                filename: memo.filename,
                content,
                attachments,
            });
        }
        notebooks.push(V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        });
    }
    Ok((notebooks, notes))
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

fn write_cloud_attachments(base: &Path, attachments: &[flowix_sync::V2RemoteAttachment]) -> Result<(), String> {
    let directory = base.join("attachments");
    std::fs::create_dir_all(&directory).map_err(sync_error)?;
    for attachment in attachments {
        let filename = &attachment.metadata.filename;
        if Path::new(filename).file_name().and_then(|value| value.to_str()) != Some(filename)
            || attachment.metadata.size_bytes != i64::try_from(attachment.content.len()).map_err(|_| "ATTACHMENT_TOO_LARGE")?
            || v2_content_hash(&attachment.content) != attachment.metadata.content_hash
        {
            return Err(format!("CLOUD_ATTACHMENT_INVALID: {filename}"));
        }
        let path = directory.join(filename);
        atomic_write_bytes(&path, &attachment.content).map_err(sync_error)?;
    }
    Ok(())
}

fn apply_v2_note_changes(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
    changes: &[&V2RemoteApply],
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

    for change in changes {
        let V2RemoteApply::Note {
            note_id,
            filename,
            content_hash,
            content,
            deleted,
            attachments,
            ..
        } = change
        else {
            continue;
        };
        if *deleted {
            if let Some(memo) = memo_file.read_memo_for_notebook_id(notebook_id, note_id) {
                let path = base.join(&memo.filename);
                crate::watcher::runtime::mark_self_write_for(app, &path);
                let derived_changed = MemoDerivedChanged::from_deleted(&memo);
                if memo_file
                    .delete_memo_result_for_notebook_id(notebook_id, note_id)
                    .map_err(sync_error)?
                {
                    memo_events::emit(
                        app,
                        MemoEvent::Deleted {
                            id: note_id.clone(),
                            path: path.to_string_lossy().into_owned(),
                            notebook_id: notebook_id.to_string(),
                            derived_changed,
                            source: MemoChangeSource::CloudSync,
                        },
                    );
                }
            }
        } else {
            let bytes = content
                .as_ref()
                .ok_or_else(|| format!("CLOUD_NOTE_CONTENT_MISSING: {note_id}"))?;
            let expected_hash = content_hash
                .as_deref()
                .ok_or_else(|| format!("CLOUD_NOTE_HASH_MISSING: {note_id}"))?;
            let actual_hash = v2_content_hash(bytes);
            if actual_hash != expected_hash {
                return Err(format!(
                        "CLOUD_NOTE_HASH_MISMATCH: note {note_id} expected {expected_hash} got {actual_hash}"
                    ));
            }
            let markdown = std::str::from_utf8(bytes)
                .map_err(|_| format!("CLOUD_NOTE_NOT_UTF8: {note_id}"))?;
            write_cloud_attachments(&base, attachments)?;
            let current_memo = memo_file.read_memo_for_notebook_id(notebook_id, note_id);
            if current_memo.is_none() {
                if let Some(location) = memo_file
                    .resolve_memo_location(note_id)
                    .map_err(sync_error)?
                {
                    return Err(format!(
                        "CLOUD_NOTE_ID_COLLISION: note {} belongs to local notebook {}",
                        note_id, location.notebook.id
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
            let overrides: MergeOverrides =
                [("key".to_string(), note_id.clone())].into_iter().collect();
            let stamped_content = merge_frontmatter(markdown, &overrides);
            atomic_write_bytes(&desired_path, stamped_content.as_bytes()).map_err(sync_error)?;
            let memo = memo_file
                .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                .map_err(sync_error)?;
            if memo.id != *note_id {
                return Err(format!(
                    "CLOUD_NOTE_ID_MISMATCH: expected {}, registered {}",
                    note_id, memo.id
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
    Ok(())
}

fn apply_v2_report(
    state: &AppState,
    app: &AppHandle,
    report: &V2AccountSyncReport,
) -> Result<(), String> {
    let mut note_changes = HashMap::<String, Vec<&V2RemoteApply>>::new();
    let mut notebook_metadata =
        HashMap::<String, (Option<String>, Option<String>, Option<i64>, bool)>::new();
    for change in &report.remote {
        match change {
            V2RemoteApply::Notebook {
                notebook_id,
                name,
                icon,
                sort_order,
                deleted,
                ..
            } => {
                notebook_metadata.insert(
                    notebook_id.clone(),
                    (name.clone(), icon.clone(), *sort_order, *deleted),
                );
            }
            V2RemoteApply::Note { notebook_id, .. } => {
                note_changes
                    .entry(notebook_id.clone())
                    .or_default()
                    .push(change);
            }
        }
    }

    for (notebook_id, changes) in note_changes {
        apply_v2_note_changes(state, app, &notebook_id, &changes)?;
    }

    if !notebook_metadata.is_empty() {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut configs = memo_file.read_notebook_configs().map_err(sync_error)?;
        let mut changed = false;
        configs.retain(|config| {
            let deleted = notebook_metadata
                .get(&config.id)
                .is_some_and(|(_, _, _, deleted)| *deleted);
            if deleted {
                changed = true;
                if state.agent_access.remove_notebook(&config.id) {
                    crate::events::emit_to(
                        app,
                        crate::commands::agent_access::AGENT_ACCESS_CHANGED_EVENT,
                        (),
                    );
                }
            }
            !deleted
        });
        for config in &mut configs {
            let Some((name, icon, sort_order, deleted)) = notebook_metadata.get(&config.id) else {
                continue;
            };
            if *deleted {
                continue;
            }
            if let Some(name) = name {
                if config.name != *name {
                    config.name.clone_from(name);
                    changed = true;
                }
            }
            if config.icon != *icon {
                config.icon.clone_from(icon);
                changed = true;
            }
            if let Some(sort_order) = sort_order {
                if config.sort != *sort_order {
                    config.sort = *sort_order;
                    changed = true;
                }
            }
        }
        if changed {
            memo_file
                .write_notebook_configs(&configs)
                .map_err(sync_error)?;
            drop(memo_file);
            crate::events::emit_to(app, crate::commands::notebook::NOTEBOOKS_CHANGED_EVENT, ());
            crate::commands::helpers::refresh_watcher_roots(state, app);
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

static ACCOUNT_SYNC_LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();

fn account_sync_lock() -> Arc<tokio::sync::Mutex<()>> {
    ACCOUNT_SYNC_LOCK
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

async fn sync_v2_account(state: &AppState, app: &AppHandle) -> Result<V2AccountSyncReport, String> {
    let sync_lock = account_sync_lock();
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now().timestamp_millis();
    let enabled = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?;
    if sync_lock.try_lock().is_err() {
        for notebook in &enabled {
            emit_sync_status(
                app,
                &CloudSyncStatus::new(
                    &notebook.notebook_id,
                    &run_id,
                    "queued",
                    "waiting",
                    started_at,
                ),
            );
        }
    }
    let _guard = sync_lock.lock().await;
    for notebook in &enabled {
        emit_sync_status(
            app,
            &CloudSyncStatus::new(
                &notebook.notebook_id,
                &run_id,
                "checking",
                "snapshot",
                started_at,
            ),
        );
        let exists = read_lock(&state.memo_file, "memo_file")
            .get_notebook_config_by_id(&notebook.notebook_id)
            .is_some();
        if exists {
            canonicalize_local_keys(state, app, &notebook.notebook_id)?;
        }
    }
    let (notebooks, notes) = v2_account_snapshot(state)?;
    for notebook in &enabled {
        emit_sync_status(
            app,
            &CloudSyncStatus::new(
                &notebook.notebook_id,
                &run_id,
                "syncing",
                "transfer",
                started_at,
            ),
        );
    }
    let report_result = state.cloud_sync.sync_v2_account(notebooks, notes).await;
    persist_rotated_token(state)?;
    let report = match report_result {
        Ok(report) => report,
        Err(error) => {
            let message = cloud_error(error);
            for notebook in &enabled {
                let mut status = CloudSyncStatus::new(
                    &notebook.notebook_id,
                    &run_id,
                    "error",
                    "failed",
                    started_at,
                );
                status.finished_at = Some(chrono::Utc::now().timestamp_millis());
                status.last_error = Some(message.clone());
                emit_sync_status(app, &status);
            }
            return Err(message);
        }
    };
    for notebook in &enabled {
        emit_sync_status(
            app,
            &CloudSyncStatus::new(
                &notebook.notebook_id,
                &run_id,
                "finalizing",
                "apply",
                started_at,
            ),
        );
    }
    apply_v2_report(state, app, &report)?;
    state
        .cloud_sync
        .complete_v2_account_sync(&report)
        .map_err(sync_error)?;
    for notebook in &enabled {
        let mut status = CloudSyncStatus::new(
            &notebook.notebook_id,
            &run_id,
            "success",
            "complete",
            started_at,
        );
        status.uploaded = report.uploaded;
        status.deleted = report.deleted;
        status.downloaded = report.remote.len();
        status.finished_at = Some(chrono::Utc::now().timestamp_millis());
        emit_sync_status(app, &status);
    }
    Ok(report)
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
        let next = values.get("account").copied().unwrap_or(0) + 1;
        values.insert("account".to_string(), next);
        next
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let is_latest = SYNC_GENERATIONS
            .get()
            .and_then(|generations| generations.lock().ok())
            .and_then(|values| values.get("account").copied())
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
                .v2_notebook(&notebook_id)
                .ok()
                .flatten()
                .is_some_and(|notebook| notebook.enabled);
        if should_sync {
            if let Err(error) = sync_v2_account(state.inner(), &app).await {
                tracing::warn!("automatic cloud sync failed for {notebook_id}: {error}");
                schedule_retry_after_failure(&app, &notebook_id);
            }
        }
    });
}

fn schedule_retry_after_failure(app: &AppHandle, notebook_id: &str) {
    let state = app.state::<AppState>();
    match state
        .cloud_sync
        .v2_retry_delay(chrono::Utc::now().timestamp_millis())
    {
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
                        .v2_enabled_notebooks()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|notebook| notebook.notebook_id)
                        .collect()
                }
            };
            if let Some(notebook_id) = notebook_ids.first() {
                let state = app.state::<AppState>();
                if let Err(error) = sync_v2_account(state.inner(), &app).await {
                    tracing::warn!("periodic cloud sync failed: {error}");
                    schedule_retry_after_failure(&app, notebook_id);
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
) -> Result<Option<V2SyncedNotebook>, String> {
    state
        .cloud_sync
        .v2_notebook(&notebook_id)
        .map_err(sync_error)
}

#[tauri::command]
pub fn cloud_list_notebook_states(state: State<AppState>) -> Result<Vec<V2SyncedNotebook>, String> {
    state.cloud_sync.v2_enabled_notebooks().map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_notebooks(
    state: State<'_, AppState>,
) -> Result<Vec<CloudNotebook>, String> {
    let notebooks_result = state.cloud_sync.v2_remote_notebooks().await;
    persist_rotated_token(state.inner())?;
    notebooks_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_link_notebook(
    notebook_id: String,
    cloud_notebook_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<V2SyncedNotebook, String> {
    if notebook_id != cloud_notebook_id {
        return Err("CLOUD_NOTEBOOK_ID_MISMATCH".to_string());
    }
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_v2_notebook_enabled(
        &V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        },
        true,
    );
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(cloud_error)?;
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
) -> Result<V2SyncedNotebook, String> {
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_v2_notebook_enabled(
        &V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        },
        enabled,
    );
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(cloud_error)?;
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
    _notebook_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    let notebook_count = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?
        .len();
    let report = sync_v2_account(state.inner(), &app).await?;
    Ok(CloudSyncResult {
        notebooks: notebook_count,
        uploaded: report.uploaded,
        deleted: report.deleted,
        downloaded: report.remote.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn cloud_error_preserves_actionable_membership_code() {
        let message = cloud_error(SyncError::Api {
            status: 402,
            code: "MEMBERSHIP_REQUIRED".to_string(),
            message: "membership required".to_string(),
            details: Some(serde_json::json!({
                "usedBytes": 128,
                "quotaBytes": 0,
                "membershipExpiresAt": null,
            })),
        });

        assert!(message.starts_with("MEMBERSHIP_REQUIRED:"));
        let details: serde_json::Value = serde_json::from_str(
            message
                .strip_prefix("MEMBERSHIP_REQUIRED:")
                .expect("membership error prefix"),
        )
        .expect("membership error details");
        assert_eq!(details["usedBytes"], 128);
        assert_eq!(details["quotaBytes"], 0);
    }

    #[test]
    fn cloud_error_preserves_quota_details_for_the_ui() {
        let message = cloud_error(SyncError::Api {
            status: 402,
            code: "STORAGE_QUOTA_EXCEEDED".to_string(),
            message: "quota exceeded".to_string(),
            details: Some(serde_json::json!({
                "usedBytes": 52_428_800,
                "quotaBytes": 52_428_800,
                "requestedDeltaBytes": 1_024,
            })),
        });

        assert!(message.starts_with("STORAGE_QUOTA_EXCEEDED:"));
        let details: serde_json::Value = serde_json::from_str(
            message
                .strip_prefix("STORAGE_QUOTA_EXCEEDED:")
                .expect("quota error prefix"),
        )
        .expect("quota error details");
        assert_eq!(details["usedBytes"], 52_428_800);
        assert_eq!(details["quotaBytes"], 52_428_800);
        assert_eq!(details["requestedDeltaBytes"], 1_024);
    }
}
