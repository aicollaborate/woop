use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine;
use flowix_core::memo_file::{Memo, Notebook};
use flowix_core::MemoService;
use flowix_sync::{CloudState, LocalChangeKind, V2LocalNotebook};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{
    cloud_sync_allowed, read_memo_file, MobileState, PendingAttachmentUpload, MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_STORAGE_BYTES,
};

#[cfg(target_os = "ios")]
extern "C" {
    fn flowix_trigger_light_haptic();
}

#[tauri::command]
pub fn mobile_haptic_light() {
    #[cfg(target_os = "ios")]
    unsafe {
        flowix_trigger_light_haptic();
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNotebookActionButton {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(target_os = "ios")]
extern "C" {
    fn flowix_sync_notebook_action_buttons(json: *const std::ffi::c_char);
    fn flowix_set_notebook_action_buttons_offset(offset: f64);
}

#[tauri::command]
pub fn mobile_sync_notebook_action_buttons(
    buttons: Vec<NativeNotebookActionButton>,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let json = serde_json::to_string(&buttons).map_err(|error| error.to_string())?;
        let json = std::ffi::CString::new(json).map_err(|error| error.to_string())?;
        unsafe {
            flowix_sync_notebook_action_buttons(json.as_ptr());
        }
    }
    #[cfg(not(target_os = "ios"))]
    let _ = buttons;
    Ok(())
}

#[tauri::command]
pub fn mobile_set_notebook_action_buttons_offset(offset: f64) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    unsafe {
        flowix_set_notebook_action_buttons_offset(offset);
    }
    #[cfg(not(target_os = "ios"))]
    let _ = offset;
    Ok(())
}

#[cfg(target_os = "ios")]
use std::ffi::{c_char, CString};

#[cfg(target_os = "ios")]
extern "C" {
    fn flowix_show_notebook_actions(notebook_id: *const c_char, name: *const c_char);
}

#[tauri::command]
pub fn mobile_show_notebook_actions(id: String, name: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let id = CString::new(id).map_err(|_| "笔记本 ID 包含无效字符".to_string())?;
        let name = CString::new(name).map_err(|_| "笔记本名称包含无效字符".to_string())?;
        unsafe {
            flowix_show_notebook_actions(id.as_ptr(), name.as_ptr());
        }
        return Ok(());
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = id;
        let _ = name;
        Ok(())
    }
}

#[derive(Serialize)]
pub struct MemoListResponse {
    memos: Vec<Memo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileNotebookRecord {
    id: String,
    name: String,
    icon: String,
    path: String,
    created_at: i64,
    updated_at: i64,
    is_default: bool,
    sort: i64,
    missing: bool,
    memo_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileLibrarySnapshot {
    notebooks: Vec<MobileNotebookRecord>,
    selected_notebook_id: Option<String>,
    tags: Vec<TagItem>,
    memos: Vec<Memo>,
}

#[derive(Serialize)]
pub struct TagItem {
    id: String,
    name: String,
}

#[derive(Serialize)]
pub struct TagListResponse {
    tags: Vec<TagItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMemoSession {
    memo: Memo,
    notebook_id: String,
    notebook_path: String,
    path: String,
    content: String,
}

#[derive(Serialize)]
pub struct WriteDocumentResult {
    path: String,
    content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    notebooks: usize,
    uploaded: usize,
    deleted: usize,
    downloaded: usize,
    conflicts: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudSyncStatus {
    notebook_id: String,
    run_id: String,
    state: String,
    phase: String,
    uploaded: usize,
    deleted: usize,
    downloaded: usize,
    started_at: i64,
    finished_at: Option<i64>,
    last_error: Option<String>,
}

pub(crate) fn emit_sync_status(
    app: &AppHandle,
    run_id: &str,
    state: &str,
    phase: &str,
    started_at: i64,
    result: Option<&CloudSyncResult>,
    last_error: Option<String>,
) {
    let result = result.cloned().unwrap_or(CloudSyncResult {
        notebooks: 0,
        uploaded: 0,
        deleted: 0,
        downloaded: 0,
        conflicts: 0,
    });
    let _ = app.emit(
        "cloud-sync-status-changed",
        CloudSyncStatus {
            notebook_id: "all".to_string(),
            run_id: run_id.to_string(),
            state: state.to_string(),
            phase: phase.to_string(),
            uploaded: result.uploaded,
            deleted: result.deleted,
            downloaded: result.downloaded,
            started_at,
            finished_at: matches!(state, "success" | "error")
                .then(|| chrono::Utc::now().timestamp_millis()),
            last_error,
        },
    );
}

fn notebook_from_config(
    state: &MobileState,
    config: flowix_core::memo_file::NotebookConfig,
) -> Notebook {
    let path = format!("{}/", state.notebook_dir(&config.id).display());
    Notebook {
        id: config.id,
        name: config.name,
        icon: config.icon.unwrap_or_default(),
        path,
        created_at: config.created_at,
        updated_at: config.updated_at,
        is_default: config.is_default,
        sort: config.sort,
        missing: false,
    }
}

fn notebook_id_for_memo(state: &MobileState, memo_id: &str) -> Result<String, String> {
    read_memo_file(state)
        .resolve_memo_location(memo_id)
        .map_err(|error| error.to_string())?
        .map(|location| location.notebook.id)
        .ok_or_else(|| "NOTE_NOT_FOUND".to_string())
}

/// Remove an app-owned notebook directory only after its registry update can
/// be committed. The temporary sibling keeps a failed index write from
/// stranding the user's data outside the visible notebook list.
fn delete_local_notebook(state: &MobileState, id: &str) -> Result<bool, String> {
    let mutation_guard = state.lock_mutations();
    let memo_file = read_memo_file(state);
    let mut configs = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    if configs.len() <= 1 {
        return Err("CANNOT_DELETE_LAST_NOTEBOOK".to_string());
    }
    let index = configs
        .iter()
        .position(|config| config.id == id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let removed = configs.remove(index);
    if removed.is_default {
        for config in &mut configs {
            config.is_default = false;
        }
        if let Some(replacement) = configs.iter_mut().min_by_key(|config| config.sort) {
            replacement.is_default = true;
        }
    }

    let directory = state.notebook_dir(id);
    let staged_directory = if directory.exists() {
        if !directory.is_dir() {
            return Err("NOTEBOOK_STORAGE_INVALID".to_string());
        }
        let staging_root = state.data_dir.join(".deleted-notebooks");
        std::fs::create_dir_all(&staging_root).map_err(|error| error.to_string())?;
        let staged = staging_root.join(uuid::Uuid::now_v7().to_string());
        std::fs::rename(&directory, &staged).map_err(|error| error.to_string())?;
        Some(staged)
    } else {
        None
    };

    if let Err(error) = memo_file.write_notebook_configs(&configs) {
        if let Some(staged) = staged_directory.as_ref() {
            let _ = std::fs::rename(staged, &directory);
        }
        return Err(format!("INDEX_WRITE_FAILED: {error}"));
    }
    drop(memo_file);
    drop(mutation_guard);

    if let Some(staged) = staged_directory {
        if let Err(error) = std::fs::remove_dir_all(&staged) {
            // The notebook is already unregistered, so preserve its delete
            // semantics and let a later app cleanup remove this private
            // staging directory instead of reporting a false rollback.
            eprintln!(
                "mobile notebook cleanup deferred for {}: {error}",
                staged.display()
            );
        }
    }
    Ok(true)
}

fn safe_attachment_file_name(name: &str) -> String {
    let leaf = Path::new(name)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("attachment");
    let safe: String = leaf
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let safe = safe.trim_matches(|character| matches!(character, ' ' | '.'));
    if safe.is_empty() {
        "attachment".to_string()
    } else {
        safe.to_string()
    }
}

fn unique_attachment_path(
    directory: &Path,
    name: &str,
    reserved_paths: &[PathBuf],
) -> Result<PathBuf, String> {
    let file_name = safe_attachment_file_name(name);
    let candidate = directory.join(&file_name);
    if !candidate.starts_with(directory) {
        return Err("INVALID_ATTACHMENT_NAME".to_string());
    }
    if !candidate.exists() && !reserved_paths.iter().any(|path| path == &candidate) {
        return Ok(candidate);
    }
    let path = Path::new(&file_name);
    let stem = path
        .file_stem()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("attachment");
    let extension = path.extension().and_then(std::ffi::OsStr::to_str);
    for index in 1..10_000 {
        let candidate = directory.join(match extension.filter(|value| !value.is_empty()) {
            Some(extension) => format!("{stem}_{index}.{extension}"),
            None => format!("{stem}_{index}"),
        });
        if !candidate.exists() && !reserved_paths.iter().any(|path| path == &candidate) {
            return Ok(candidate);
        }
    }
    Err("ATTACHMENT_NAME_EXHAUSTED".to_string())
}

const CLOUD_STATE_CHANGED_EVENT: &str = "cloud-state-changed";
static SESSION_RESTORE_GENERATION: AtomicU64 = AtomicU64::new(0);
static SESSION_RESTORE_ATTEMPTS: AtomicU32 = AtomicU32::new(0);

fn schedule_session_restore(app: AppHandle) {
    let generation = SESSION_RESTORE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let attempt = SESSION_RESTORE_ATTEMPTS
        .fetch_add(1, Ordering::SeqCst)
        .min(4);
    let delay = Duration::from_secs(15 * (1_u64 << attempt));
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if SESSION_RESTORE_GENERATION.load(Ordering::SeqCst) == generation {
            restore_session_and_sync(app).await;
        }
    });
}

async fn restore_session_and_sync(app: AppHandle) {
    let state = app.state::<MobileState>();
    let _guard = state.initialize_lock.lock().await;
    let result = async {
        let current = state
            .cloud_sync
            .state()
            .map_err(|error| error.to_string())?;
        if !current.authenticated {
            if let Some(token) = state.load_refresh_token()? {
                match state.cloud_sync.restore(&token).await {
                    Ok(outcome) => {
                        let user_id = &outcome
                            .state
                            .account
                            .as_ref()
                            .ok_or_else(|| "CLOUD_ACCOUNT_MISSING".to_string())?
                            .user
                            .id;
                        if let Err(error) = state.ensure_cloud_owner(user_id) {
                            let _ = state.cloud_sync.logout().await;
                            state.delete_refresh_token()?;
                            return Err(error);
                        }
                        state.save_refresh_token(&outcome.refresh_token)?;
                        SESSION_RESTORE_ATTEMPTS.store(0, Ordering::SeqCst);
                    }
                    Err(flowix_sync::SyncError::NotAuthenticated)
                    | Err(flowix_sync::SyncError::Api { status: 401, .. }) => {
                        state.delete_refresh_token()?
                    }
                    Err(error) => {
                        eprintln!("mobile session restore deferred: {error}");
                        schedule_session_restore(app.clone());
                    }
                }
            }
        }
        let next = state
            .cloud_sync
            .state()
            .map_err(|error| error.to_string())?;
        let sync_allowed = cloud_sync_allowed(&next);
        state
            .cloud_sync
            .set_enabled(sync_allowed)
            .map_err(|error| error.to_string())?;
        if sync_allowed {
            if let Err(error) = crate::sync::bootstrap_and_sync(state.inner()).await {
                crate::sync::schedule_retry_after_failure(app.clone(), &error);
                return Err(error);
            }
        }
        Ok::<(), String>(())
    }
    .await;

    if let Err(error) = result {
        eprintln!("mobile background initialization failed: {error}");
    }
    if let Ok(cloud) = state.cloud_sync.state() {
        let _ = app.emit(CLOUD_STATE_CHANGED_EVENT, cloud);
    }
}

#[tauri::command]
pub fn mobile_initialize(
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    state.ensure_local_notebook()?;
    let initial = state
        .cloud_sync
        .state()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn(restore_session_and_sync(app));
    Ok(initial)
}

#[tauri::command]
pub fn cloud_get_state(state: State<'_, MobileState>) -> Result<CloudState, String> {
    state.cloud_sync.state().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn mobile_list_cloud_notebooks(
    state: State<'_, MobileState>,
) -> Result<Vec<flowix_sync::CloudNotebook>, String> {
    let notebooks = state
        .cloud_sync
        .v2_remote_notebooks()
        .await
        .map_err(|error| error.to_string())?;
    state.persist_rotated_refresh_token()?;
    Ok(notebooks)
}

#[tauri::command]
pub async fn cloud_login(
    email: String,
    password: String,
    state: State<'_, MobileState>,
) -> Result<CloudState, String> {
    let outcome = state
        .cloud_sync
        .login(email.trim(), &password)
        .await
        .map_err(|error| error.to_string())?;
    let user_id = &outcome
        .state
        .account
        .as_ref()
        .ok_or_else(|| "CLOUD_ACCOUNT_MISSING".to_string())?
        .user
        .id;
    if let Err(error) = state.ensure_cloud_owner(user_id) {
        let _ = state.cloud_sync.logout().await;
        return Err(error);
    }
    state.save_refresh_token(&outcome.refresh_token)?;
    state
        .cloud_sync
        .set_enabled(cloud_sync_allowed(&outcome.state))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cloud_refresh_membership(
    state: State<'_, MobileState>,
) -> Result<flowix_sync::CloudMembership, String> {
    let membership = state
        .cloud_sync
        .refresh_membership()
        .await
        .map_err(|error| error.to_string())?;
    state.persist_rotated_refresh_token()?;
    let next = state
        .cloud_sync
        .state()
        .map_err(|error| error.to_string())?;
    state
        .cloud_sync
        .set_enabled(cloud_sync_allowed(&next))
        .map_err(|error| error.to_string())?;
    Ok(membership)
}

#[tauri::command]
pub async fn cloud_logout(state: State<'_, MobileState>) -> Result<CloudState, String> {
    state
        .cloud_sync
        .set_enabled(false)
        .map_err(|error| error.to_string())?;
    state
        .cloud_sync
        .logout()
        .await
        .map_err(|error| error.to_string())?;
    state.delete_refresh_token()?;
    state.cloud_sync.state().map_err(|error| error.to_string())
}

/// Deliberately unlocks this installation for a different cloud account while
/// retaining every local notebook. The UI requires an explicit confirmation;
/// keeping the check here as well prevents an authenticated session from
/// changing its account affinity underneath an active sync.
#[tauri::command]
pub fn mobile_reset_cloud_binding(state: State<'_, MobileState>) -> Result<(), String> {
    let cloud = state
        .cloud_sync
        .state()
        .map_err(|error| error.to_string())?;
    if cloud.authenticated {
        return Err("MOBILE_LOGOUT_REQUIRED_BEFORE_ACCOUNT_RESET".to_string());
    }
    state.delete_refresh_token()?;
    state.clear_cloud_owner()
}

#[tauri::command]
pub async fn mobile_bootstrap_cloud(
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    let cloud = state
        .cloud_sync
        .state()
        .map_err(|error| error.to_string())?;
    if !cloud_sync_allowed(&cloud) {
        return Err("CLOUD_MEMBERSHIP_REQUIRED".to_string());
    }
    crate::sync::reset_auto_sync_circuit();
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now().timestamp_millis();
    emit_sync_status(&app, &run_id, "syncing", "transfer", started_at, None, None);
    let sync_result = crate::sync::bootstrap_and_sync(state.inner()).await;
    let (notebooks, report) = match sync_result {
        Ok(value) => value,
        Err(error) => {
            emit_sync_status(
                &app,
                &run_id,
                "error",
                "failed",
                started_at,
                None,
                Some(error.clone()),
            );
            crate::sync::schedule_retry_after_failure(app, &error);
            return Err(error);
        }
    };
    let result = CloudSyncResult {
        notebooks,
        uploaded: report.uploaded,
        deleted: report.deleted,
        downloaded: report.remote.len(),
        conflicts: 0,
    };
    emit_sync_status(
        &app,
        &run_id,
        "success",
        "complete",
        started_at,
        Some(&result),
        None,
    );
    Ok(result)
}

#[tauri::command]
pub async fn cloud_sync_now(
    _notebook_id: Option<String>,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    mobile_bootstrap_cloud(state, app).await
}

#[tauri::command]
pub fn get_notebooks(state: State<'_, MobileState>) -> Result<Vec<Notebook>, String> {
    read_memo_file(&state)
        .read_notebook_configs()
        .map(|configs| {
            configs
                .into_iter()
                .map(|config| notebook_from_config(&state, config))
                .collect()
        })
        .map_err(|error| error.to_string())
}

/// Fetch the complete first-screen library state in one IPC call. Keeping
/// notebook counts in the native index avoids one WebView round-trip per
/// notebook during launch and cloud reconciliation.
fn build_mobile_library_snapshot(
    preferred_notebook_id: Option<String>,
    selected_tag_id: Option<String>,
    state: &MobileState,
) -> Result<MobileLibrarySnapshot, String> {
    let memo_file = read_memo_file(state);
    let configs = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    let selected_notebook_id = preferred_notebook_id
        .as_ref()
        .filter(|id| configs.iter().any(|config| config.id == id.as_str()))
        .cloned()
        .or_else(|| configs.first().map(|config| config.id.clone()));
    // A deleted/restored notebook can make the preferred id fall back to the
    // first library entry. Never carry that old notebook's tag filter into
    // the replacement notebook.
    let selected_tag_id = selected_tag_id
        .filter(|_| preferred_notebook_id.as_deref() == selected_notebook_id.as_deref());
    let notebooks = configs
        .into_iter()
        .map(|config| {
            let notebook = notebook_from_config(state, config);
            let memo_count = memo_file
                .read_all_memos_for_notebook_id(Some(&notebook.id))
                .len();
            MobileNotebookRecord {
                id: notebook.id,
                name: notebook.name,
                icon: notebook.icon,
                path: notebook.path,
                created_at: notebook.created_at,
                updated_at: notebook.updated_at,
                is_default: notebook.is_default,
                sort: notebook.sort,
                missing: notebook.missing,
                memo_count,
            }
        })
        .collect::<Vec<_>>();
    let tags = selected_notebook_id
        .as_deref()
        .map(|notebook_id| {
            memo_file
                .derived_tags_for_notebook_id(Some(notebook_id))
                .into_iter()
                .map(|tag| TagItem {
                    id: tag.id,
                    name: tag.name,
                })
                .collect()
        })
        .unwrap_or_default();
    let memos = selected_notebook_id
        .as_deref()
        .map(|notebook_id| {
            memo_file.read_all_memos_filtered_for_notebook_id(
                Some(notebook_id),
                if selected_tag_id.is_some() {
                    "tagged"
                } else {
                    "all"
                },
                "updatedAt",
                selected_tag_id.as_deref(),
            )
        })
        .unwrap_or_default();

    Ok(MobileLibrarySnapshot {
        notebooks,
        selected_notebook_id,
        tags,
        memos,
    })
}

#[tauri::command]
pub fn mobile_get_library_snapshot(
    preferred_notebook_id: Option<String>,
    selected_tag_id: Option<String>,
    state: State<'_, MobileState>,
) -> Result<MobileLibrarySnapshot, String> {
    build_mobile_library_snapshot(preferred_notebook_id, selected_tag_id, state.inner())
}

#[tauri::command]
pub fn mobile_create_notebook(
    name: String,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<Notebook, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("INVALID_NAME".to_string());
    }

    let mutation_guard = state.lock_mutations();
    let id = format!("nb_{}", uuid::Uuid::now_v7());
    let path = state.notebook_dir(&id);
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    let memo_file = read_memo_file(&state);
    let mut configs = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    let config = flowix_core::memo_file::NotebookConfig {
        id,
        name: name.to_string(),
        icon: None,
        path: format!("{}/", path.display()),
        is_default: false,
        sort: configs.iter().map(|config| config.sort).max().unwrap_or(0) + 10,
        created_at: now,
        updated_at: now,
    };
    configs.push(config.clone());
    memo_file
        .write_notebook_configs(&configs)
        .map_err(|error| error.to_string())?;
    drop(memo_file);
    drop(mutation_guard);

    let cloud = state
        .cloud_sync
        .state()
        .map_err(|error| error.to_string())?;
    if cloud.enabled && cloud_sync_allowed(&cloud) {
        state
            .cloud_sync
            .set_v2_notebook_enabled(
                &V2LocalNotebook {
                    id: config.id.clone(),
                    name: config.name.clone(),
                    icon: config.icon.clone(),
                    sort_order: config.sort,
                },
                true,
            )
            .map_err(|error| error.to_string())?;
        crate::sync::schedule_sync(app);
    }
    Ok(notebook_from_config(&state, config))
}

#[tauri::command]
pub fn mobile_rename_notebook(
    id: String,
    name: String,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<Notebook, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("INVALID_NAME".to_string());
    }

    let mutation_guard = state.lock_mutations();
    let memo_file = read_memo_file(&state);
    let mut configs = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    let config = configs
        .iter_mut()
        .find(|config| config.id == id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    config.name = name.to_string();
    config.updated_at = chrono::Utc::now().timestamp_millis();
    let updated = config.clone();
    memo_file
        .write_notebook_configs(&configs)
        .map_err(|error| error.to_string())?;
    drop(memo_file);
    drop(mutation_guard);

    let changed = state
        .cloud_sync
        .record_v2_notebook_change(&V2LocalNotebook {
            id: updated.id.clone(),
            name: updated.name.clone(),
            icon: updated.icon.clone(),
            sort_order: updated.sort,
        })
        .map_err(|error| error.to_string())?;
    if changed {
        crate::sync::schedule_sync(app);
    }
    Ok(notebook_from_config(&state, updated))
}

#[tauri::command]
pub fn mobile_delete_notebook(
    id: String,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<bool, String> {
    let deleted = delete_local_notebook(state.inner(), &id)?;
    if deleted {
        if let Err(error) = state.cloud_sync.record_v2_notebook_delete(&id) {
            // Match desktop behavior: local deletion remains complete even if
            // a transient sync-store failure delays cloud propagation.
            eprintln!("mobile cloud notebook deletion deferred for {id}: {error}");
        } else {
            crate::sync::schedule_sync(app);
        }
    }
    Ok(deleted)
}

#[tauri::command]
pub fn set_current_notebook(
    notebook_id: Option<String>,
    state: State<'_, MobileState>,
) -> Result<(), String> {
    state
        .memo_file
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .set_current_notebook(notebook_id);
    Ok(())
}

#[tauri::command]
pub fn get_all_tags(notebook_id: Option<String>, state: State<'_, MobileState>) -> TagListResponse {
    let tags = read_memo_file(&state)
        .derived_tags_for_notebook_id(notebook_id.as_deref())
        .into_iter()
        .map(|tag| TagItem {
            id: tag.id,
            name: tag.name,
        })
        .collect();
    TagListResponse { tags }
}

#[tauri::command]
pub fn get_memos(
    notebook_id: Option<String>,
    filter: Option<String>,
    sort: Option<String>,
    tag_id: Option<String>,
    state: State<'_, MobileState>,
) -> MemoListResponse {
    let memos = read_memo_file(&state).read_all_memos_filtered_for_notebook_id(
        notebook_id.as_deref(),
        filter.as_deref().unwrap_or("all"),
        sort.as_deref().unwrap_or("updatedAt"),
        tag_id.as_deref(),
    );
    MemoListResponse { memos }
}

fn upsert_search_entry(
    state: &MobileState,
    memo_file: &flowix_core::memo_file::MemoFile,
    id: &str,
) {
    let mut index = state
        .search
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = flowix_core::search::upsert_index_from_store(&mut index, memo_file, id);
}

fn remove_search_entry(state: &MobileState, id: &str) {
    let mut index = state
        .search
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = flowix_core::search::remove_from_index(&mut index, id);
}

fn search_memos_in_notebook(
    state: &MobileState,
    memo_file: &flowix_core::memo_file::MemoFile,
    notebook_id: &str,
    tag_id: Option<&str>,
    query: &str,
) -> Result<Vec<Memo>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(memo_file.read_all_memos_filtered_for_notebook_id(
            Some(notebook_id),
            if tag_id.is_some() { "tagged" } else { "all" },
            "updatedAt",
            tag_id,
        ));
    }

    let needs_rebuild = state
        .search
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .current_notebook()
        != Some(notebook_id);
    if needs_rebuild {
        let mut index = state
            .search
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !index.is_loaded() || index.current_notebook() != Some(notebook_id) {
            flowix_core::search::rebuild_index_from_store(
                &mut index,
                memo_file,
                notebook_id.to_string(),
            );
        }
    }
    let hit_ids = state
        .search
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .search(query, 200)
        .into_iter()
        .map(|hit| hit.id)
        .collect::<Vec<_>>();
    let mut memos_by_id: HashMap<_, _> = memo_file
        .read_all_memos_filtered_for_notebook_id(
            Some(notebook_id),
            if tag_id.is_some() { "tagged" } else { "all" },
            "updatedAt",
            tag_id,
        )
        .into_iter()
        .map(|memo| (memo.id.clone(), memo))
        .collect();

    Ok(hit_ids
        .into_iter()
        .filter_map(|id| memos_by_id.remove(&id))
        .collect())
}

/// Full-text search for the current mobile list. The shared core search keeps
/// title, tags, and Markdown body semantics consistent with desktop/CLI;
/// this command only turns its ranked ids back into the list-row payload.
#[tauri::command]
pub fn mobile_search_memos(
    notebook_id: String,
    tag_id: Option<String>,
    query: String,
    state: State<'_, MobileState>,
) -> Result<MemoListResponse, String> {
    let memo_file = read_memo_file(&state);
    Ok(MemoListResponse {
        memos: search_memos_in_notebook(
            state.inner(),
            &memo_file,
            &notebook_id,
            tag_id.as_deref(),
            &query,
        )?,
    })
}

#[tauri::command]
pub fn read_memo(id: String, state: State<'_, MobileState>) -> Option<Memo> {
    read_memo_file(&state).read_memo(&id)
}

#[tauri::command]
pub fn open_memo_session(
    id: String,
    state: State<'_, MobileState>,
) -> Result<Option<OpenMemoSession>, String> {
    let memo_file = read_memo_file(&state);
    let mut service = MemoService::new(&memo_file);
    let document = match service.get_memo(&id) {
        Ok(document) => document,
        Err(flowix_core::FlowixError::NotFound(_)) => {
            // `get_memo` also returns NotFound when the index entry remains
            // but its Markdown file was removed externally. Prune that stale
            // entry now so a subsequent list reload cannot resurrect it.
            if memo_file
                .resolve_memo_location(&id)
                .map_err(|error| error.to_string())?
                .is_some()
            {
                let mutation_guard = state.lock_mutations();
                memo_file
                    .delete_memo_result_global(&id)
                    .map_err(|error| error.to_string())?;
                remove_search_entry(state.inner(), &id);
                drop(mutation_guard);
            }
            return Ok(None);
        }
        Err(error) => return Err(error.to_string()),
    };
    let path = document.path.to_string_lossy().into_owned();
    let notebook_path = format!("{}/", state.notebook_dir(&document.notebook.id).display());
    let notebook_id = document.notebook.id.clone();
    let memo = flowix_core::memo_file::MemoFile::index_entry_to_memo(&document.entry);
    Ok(Some(OpenMemoSession {
        memo,
        notebook_id,
        notebook_path,
        path,
        content: document.body,
    }))
}

#[tauri::command]
pub fn read_document(
    file_path: String,
    state: State<'_, MobileState>,
) -> Result<Option<String>, String> {
    let allowed = read_memo_file(&state)
        .read_notebook_configs()
        .map_err(|error| error.to_string())?
        .into_iter()
        .any(|notebook| {
            state
                .notebook_dir(&notebook.id)
                .join(PathBuf::from(&file_path).file_name().unwrap_or_default())
                == Path::new(&file_path)
        });
    if !allowed {
        return Err("DOCUMENT_PATH_NOT_ALLOWED".to_string());
    }
    match std::fs::read_to_string(file_path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn write_document(
    key: String,
    content: String,
    expectedContent: Option<String>,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<Option<WriteDocumentResult>, String> {
    let mutation_guard = state.lock_mutations();
    let memo_file = read_memo_file(&state);
    let mut service = MemoService::new(&memo_file);
    let current = service.get_memo(&key).map_err(|error| error.to_string())?;
    if expectedContent
        .as_deref()
        .is_some_and(|expected| expected != current.body)
    {
        return Ok(None);
    }
    let edited = service
        .save_memo(&key, &content)
        .map_err(|error| error.to_string())?;
    let memo = edited
        .memo
        .ok_or_else(|| "SAVE_RESULT_MISSING".to_string())?;
    let notebook_id = current.notebook.id;
    let final_content = std::fs::read_to_string(&edited.path).map_err(|error| error.to_string())?;
    state
        .cloud_sync
        .record_v2_local_change(
            &notebook_id,
            &memo.id,
            LocalChangeKind::Put,
            &flowix_sync::v2_content_hash(final_content.as_bytes()),
        )
        .map_err(|error| error.to_string())?;
    upsert_search_entry(state.inner(), &memo_file, &memo.id);
    drop(memo_file);
    drop(mutation_guard);
    crate::sync::schedule_sync(app);
    Ok(Some(WriteDocumentResult {
        path: edited.path.to_string_lossy().into_owned(),
        content: final_content,
    }))
}

const MAX_ATTACHMENT_CHUNK_BYTES: usize = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadStart {
    upload_id: String,
}

fn valid_attachment_mime_type(value: &str) -> bool {
    if value.is_empty() || value.len() > 127 || value.bytes().any(|byte| byte.is_ascii_control()) {
        return false;
    }
    let Some((major, minor)) = value.split_once('/') else {
        return false;
    };
    !major.is_empty()
        && !minor.is_empty()
        && !minor.contains('/')
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'-' | b'.' | b'+' | b'/'
                )
        })
}

fn directory_size(path: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            total = total.saturating_add(directory_size(&entry.path())?);
        } else if kind.is_file() {
            total =
                total.saturating_add(entry.metadata().map_err(|error| error.to_string())?.len());
        }
    }
    Ok(total)
}

fn attachment_storage_bytes(state: &MobileState) -> Result<u64, String> {
    let configs = read_memo_file(state)
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    configs.into_iter().try_fold(0_u64, |total, notebook| {
        Ok(total.saturating_add(directory_size(
            &state.notebook_dir(&notebook.id).join("attachments"),
        )?))
    })
}

/// Starts a bounded, app-private attachment stream. Browser data only reaches
/// a temporary sibling file; `finish` atomically renames it into attachments
/// after the promised byte count has arrived.
fn begin_attachment_upload(
    file_name: String,
    mime_type: String,
    size_bytes: u64,
    memo_id: String,
    state: &MobileState,
) -> Result<AttachmentUploadStart, String> {
    if size_bytes == 0 || size_bytes > MAX_ATTACHMENT_BYTES {
        return Err("ATTACHMENT_SIZE_LIMIT_EXCEEDED".to_string());
    }
    if !valid_attachment_mime_type(&mime_type) {
        return Err("INVALID_ATTACHMENT_MIME_TYPE".to_string());
    }

    let mutation_guard = state.lock_mutations();
    let notebook_id = notebook_id_for_memo(state, &memo_id)?;
    let attachment_dir = state.notebook_dir(&notebook_id).join("attachments");
    std::fs::create_dir_all(&attachment_dir).map_err(|error| error.to_string())?;
    let mut uploads = state
        .attachment_uploads
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let reserved_bytes = uploads.values().fold(0_u64, |total, upload| {
        total.saturating_add(upload.expected_bytes)
    });
    if attachment_storage_bytes(state)?
        .saturating_add(reserved_bytes)
        .saturating_add(size_bytes)
        > MAX_ATTACHMENT_STORAGE_BYTES
    {
        return Err("ATTACHMENT_STORAGE_LIMIT_EXCEEDED".to_string());
    }

    let reserved_paths = uploads
        .values()
        .map(|upload| upload.destination_path.clone())
        .collect::<Vec<_>>();
    let destination_path = unique_attachment_path(&attachment_dir, &file_name, &reserved_paths)?;
    let upload_id = uuid::Uuid::now_v7().to_string();
    let upload_dir = state.data_dir.join(".uploads");
    std::fs::create_dir_all(&upload_dir).map_err(|error| error.to_string())?;
    let temporary_path = upload_dir.join(format!("{upload_id}.part"));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| error.to_string())?;
    uploads.insert(
        upload_id.clone(),
        PendingAttachmentUpload {
            temporary_path,
            destination_path,
            expected_bytes: size_bytes,
            written_bytes: 0,
        },
    );
    drop(uploads);
    drop(mutation_guard);
    Ok(AttachmentUploadStart { upload_id })
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn mobile_begin_attachment_upload(
    fileName: String,
    mimeType: String,
    sizeBytes: u64,
    memoId: String,
    state: State<'_, MobileState>,
) -> Result<AttachmentUploadStart, String> {
    begin_attachment_upload(fileName, mimeType, sizeBytes, memoId, state.inner())
}

fn write_attachment_chunk(
    upload_id: String,
    content: String,
    state: &MobileState,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|error| format!("INVALID_ATTACHMENT_CONTENT: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_CHUNK_BYTES {
        return Err("ATTACHMENT_CHUNK_SIZE_INVALID".to_string());
    }
    let mut uploads = state
        .attachment_uploads
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let upload = uploads
        .get_mut(&upload_id)
        .ok_or_else(|| "ATTACHMENT_UPLOAD_NOT_FOUND".to_string())?;
    let chunk_bytes = u64::try_from(bytes.len()).map_err(|_| "ATTACHMENT_CHUNK_SIZE_INVALID")?;
    if upload.written_bytes.saturating_add(chunk_bytes) > upload.expected_bytes {
        return Err("ATTACHMENT_UPLOAD_SIZE_MISMATCH".to_string());
    }
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&upload.temporary_path)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    upload.written_bytes = upload.written_bytes.saturating_add(chunk_bytes);
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn mobile_write_attachment_chunk(
    uploadId: String,
    content: String,
    state: State<'_, MobileState>,
) -> Result<(), String> {
    write_attachment_chunk(uploadId, content, state.inner())
}

fn finish_attachment_upload(upload_id: String, state: &MobileState) -> Result<String, String> {
    let upload = {
        let mut uploads = state
            .attachment_uploads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let upload = uploads
            .remove(&upload_id)
            .ok_or_else(|| "ATTACHMENT_UPLOAD_NOT_FOUND".to_string())?;
        if upload.written_bytes != upload.expected_bytes {
            let _ = std::fs::remove_file(&upload.temporary_path);
            return Err("ATTACHMENT_UPLOAD_SIZE_MISMATCH".to_string());
        }
        upload
    };
    let mutation_guard = state.lock_mutations();
    let result = (|| {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&upload.temporary_path)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        if upload.destination_path.exists() {
            return Err("ATTACHMENT_DESTINATION_EXISTS".to_string());
        }
        std::fs::rename(&upload.temporary_path, &upload.destination_path)
            .map_err(|error| error.to_string())?;
        Ok(upload.destination_path.to_string_lossy().into_owned())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&upload.temporary_path);
    }
    drop(mutation_guard);
    result
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn mobile_finish_attachment_upload(
    uploadId: String,
    state: State<'_, MobileState>,
) -> Result<String, String> {
    finish_attachment_upload(uploadId, state.inner())
}

fn cancel_attachment_upload(upload_id: String, state: &MobileState) {
    let upload = state
        .attachment_uploads
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&upload_id);
    if let Some(upload) = upload {
        let _ = std::fs::remove_file(upload.temporary_path);
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn mobile_cancel_attachment_upload(uploadId: String, state: State<'_, MobileState>) {
    cancel_attachment_upload(uploadId, state.inner());
}

#[tauri::command]
pub fn add_document(
    tag: Option<String>,
    notebook_id: Option<String>,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<Memo, String> {
    let mutation_guard = state.lock_mutations();
    let notebook_id = notebook_id.ok_or_else(|| "NOTEBOOK_REQUIRED".to_string())?;
    let title = chrono::Local::now().format("%Y-%m-%d").to_string();
    let body = format!("# {title}\n");
    let memo_file = read_memo_file(&state);
    let created = MemoService::new(&memo_file)
        .create_memo_named_with_tag(
            Some(&notebook_id),
            &title,
            &body,
            tag.as_deref().filter(|value| !value.trim().is_empty()),
        )
        .map_err(|error| error.to_string())?;
    let final_content = std::fs::read(&created.path).map_err(|error| error.to_string())?;
    state
        .cloud_sync
        .record_v2_local_change(
            &notebook_id,
            &created.memo.id,
            LocalChangeKind::Put,
            &flowix_sync::v2_content_hash(&final_content),
        )
        .map_err(|error| error.to_string())?;
    upsert_search_entry(state.inner(), &memo_file, &created.memo.id);
    let memo = created.memo;
    drop(memo_file);
    drop(mutation_guard);
    crate::sync::schedule_sync(app);
    Ok(memo)
}

#[tauri::command]
pub fn delete_memo(
    id: String,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<bool, String> {
    let mutation_guard = state.lock_mutations();
    let notebook_id = notebook_id_for_memo(&state, &id)?;
    let memo_file = read_memo_file(&state);
    let deleted = MemoService::new(&memo_file)
        .delete_memo(&id)
        .map_err(|error| error.to_string())?;
    if !deleted.file_removed {
        return Ok(false);
    }
    state
        .cloud_sync
        .record_v2_local_change(&notebook_id, &id, LocalChangeKind::Delete, "")
        .map_err(|error| error.to_string())?;
    remove_search_entry(state.inner(), &id);
    drop(memo_file);
    drop(mutation_guard);
    crate::sync::schedule_sync(app);
    Ok(true)
}

fn set_memo_favorite(
    id: String,
    favorited: bool,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<bool, String> {
    let mutation_guard = state.lock_mutations();
    let memo_file = read_memo_file(&state);
    let mut document = MemoService::new(&memo_file)
        .get_memo(&id)
        .map_err(|error| error.to_string())?;
    document.entry.favorited = favorited;
    document.entry.updated_at = chrono::Utc::now().timestamp_millis();
    let memo = flowix_core::memo_file::MemoFile::index_entry_to_memo(&document.entry);
    MemoService::new(&memo_file)
        .sync_memo_metadata(&memo)
        .map_err(|error| error.to_string())?;
    state
        .cloud_sync
        .record_v2_local_change(
            &document.notebook.id,
            &id,
            LocalChangeKind::Put,
            &flowix_sync::v2_content_hash(document.body.as_bytes()),
        )
        .map_err(|error| error.to_string())?;
    upsert_search_entry(state.inner(), &memo_file, &id);
    drop(memo_file);
    drop(mutation_guard);
    crate::sync::schedule_sync(app);
    Ok(true)
}

#[tauri::command]
pub fn favorite_memo(
    id: String,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<bool, String> {
    set_memo_favorite(id, true, state, app)
}

#[tauri::command]
pub fn unfavorite_memo(
    id: String,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<bool, String> {
    set_memo_favorite(id, false, state, app)
}

#[tauri::command]
pub fn get_used_memo_tag_ids(
    notebook_id: Option<String>,
    state: State<'_, MobileState>,
) -> Result<serde_json::Value, String> {
    let (ids, counts, total, agents, todos) = MemoService::new(&read_memo_file(&state))
        .tag_usage_summary(notebook_id.as_deref())
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "usedTagIds": ids,
        "tagCounts": counts.into_iter().map(|(tag_id, count)| serde_json::json!({ "tagId": tag_id, "count": count })).collect::<Vec<_>>(),
        "totalMemoCount": total,
        "agentMemoCount": agents,
        "todoMemoCount": todos,
    }))
}

#[allow(dead_code)]
fn _assert_notebook_lookup(state: &MobileState, memo_id: &str) -> Result<String, String> {
    notebook_id_for_memo(state, memo_id)
}

#[cfg(test)]
mod tests {
    use flowix_core::{memo_file::NotebookConfig, MemoService};

    use super::{
        begin_attachment_upload, build_mobile_library_snapshot, delete_local_notebook,
        finish_attachment_upload, read_memo_file, remove_search_entry, search_memos_in_notebook,
        upsert_search_entry, valid_attachment_mime_type, write_attachment_chunk, MobileState,
    };

    fn state_with_memo() -> (tempfile::TempDir, MobileState, String, String) {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = MobileState::new(directory.path().to_path_buf()).expect("mobile state");
        state.ensure_local_notebook().expect("default notebook");
        let notebook_id = read_memo_file(&state)
            .read_notebook_configs()
            .expect("notebook configs")[0]
            .id
            .clone();
        let memo = MemoService::new(&read_memo_file(&state))
            .create_memo_named(Some(&notebook_id), "Attachment", "# Attachment\n")
            .expect("create memo");
        (directory, state, notebook_id, memo.memo.id)
    }

    #[test]
    fn attachment_stream_is_bounded_and_committed_atomically() {
        let (_directory, state, notebook_id, memo_id) = state_with_memo();
        let upload = begin_attachment_upload(
            "hello.txt".to_string(),
            "text/plain".to_string(),
            3,
            memo_id,
            &state,
        )
        .expect("start upload");
        write_attachment_chunk(upload.upload_id.clone(), "YWJj".to_string(), &state)
            .expect("write chunk");
        let saved = finish_attachment_upload(upload.upload_id, &state).expect("finish upload");

        assert_eq!(std::fs::read(&saved).expect("attachment bytes"), b"abc");
        assert!(state
            .data_dir
            .join(".uploads")
            .read_dir()
            .expect("uploads directory")
            .next()
            .is_none());
        assert!(std::path::Path::new(&saved)
            .starts_with(state.notebook_dir(&notebook_id).join("attachments")));
    }

    #[test]
    fn incomplete_attachment_stream_is_rejected_and_removed() {
        let (_directory, state, _notebook_id, memo_id) = state_with_memo();
        let upload = begin_attachment_upload(
            "partial.txt".to_string(),
            "text/plain".to_string(),
            4,
            memo_id,
            &state,
        )
        .expect("start upload");
        write_attachment_chunk(upload.upload_id.clone(), "YWJj".to_string(), &state)
            .expect("write chunk");
        assert_eq!(
            finish_attachment_upload(upload.upload_id, &state).unwrap_err(),
            "ATTACHMENT_UPLOAD_SIZE_MISMATCH"
        );
        assert!(state
            .data_dir
            .join(".uploads")
            .read_dir()
            .expect("uploads directory")
            .next()
            .is_none());
    }

    #[test]
    fn attachment_mime_type_rejects_control_characters_and_missing_subtypes() {
        assert!(valid_attachment_mime_type("image/png"));
        assert!(valid_attachment_mime_type("application/octet-stream"));
        assert!(!valid_attachment_mime_type("image"));
        assert!(!valid_attachment_mime_type("image/\nsvg+xml"));
    }

    #[test]
    fn library_snapshot_returns_counts_and_preferred_library_in_one_response() {
        let (_directory, state, notebook_id, memo_id) = state_with_memo();
        let snapshot = build_mobile_library_snapshot(Some(notebook_id.clone()), None, &state)
            .expect("library snapshot");

        assert_eq!(
            snapshot.selected_notebook_id.as_deref(),
            Some(notebook_id.as_str())
        );
        assert_eq!(snapshot.notebooks.len(), 1);
        assert_eq!(snapshot.notebooks[0].memo_count, 1);
        assert_eq!(snapshot.memos[0].id, memo_id);
    }

    #[test]
    fn full_text_search_returns_list_rows_in_relevance_order() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = MobileState::new(directory.path().to_path_buf()).expect("mobile state");
        state.ensure_local_notebook().expect("default notebook");
        let notebook_id = read_memo_file(&state)
            .read_notebook_configs()
            .expect("notebook configs")[0]
            .id
            .clone();
        let memo_file = read_memo_file(&state);
        let created = MemoService::new(&memo_file)
            .create_memo_named_with_tag(
                Some(&notebook_id),
                "普通标题",
                "# 普通标题\n\n这一篇正文包含独特关键词。\n",
                None,
            )
            .expect("create memo");

        let results =
            search_memos_in_notebook(&state, &memo_file, &notebook_id, None, "独特关键词")
                .expect("search memos");
        assert_eq!(
            results.iter().map(|memo| &memo.id).collect::<Vec<_>>(),
            vec![&created.memo.id]
        );
    }

    #[test]
    fn cached_search_index_tracks_local_creates_and_deletes() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = MobileState::new(directory.path().to_path_buf()).expect("mobile state");
        state.ensure_local_notebook().expect("default notebook");
        let notebook_id = read_memo_file(&state)
            .read_notebook_configs()
            .expect("notebook configs")[0]
            .id
            .clone();
        let memo_file = read_memo_file(&state);

        // The first search builds the notebook index once.
        assert!(
            search_memos_in_notebook(&state, &memo_file, &notebook_id, None, "missing")
                .expect("initial search")
                .is_empty()
        );
        let created = MemoService::new(&memo_file)
            .create_memo_named_with_tag(
                Some(&notebook_id),
                "增量索引",
                "# 增量索引\n\n只会出现在缓存索引中的关键词。\n",
                None,
            )
            .expect("create memo");

        upsert_search_entry(&state, &memo_file, &created.memo.id);
        assert_eq!(
            search_memos_in_notebook(&state, &memo_file, &notebook_id, None, "缓存索引")
                .expect("search after upsert")
                .iter()
                .map(|memo| memo.id.as_str())
                .collect::<Vec<_>>(),
            vec![created.memo.id.as_str()],
        );

        MemoService::new(&memo_file)
            .delete_memo(&created.memo.id)
            .expect("delete memo");
        remove_search_entry(&state, &created.memo.id);
        assert!(
            search_memos_in_notebook(&state, &memo_file, &notebook_id, None, "缓存索引")
                .expect("search after delete")
                .is_empty()
        );
    }

    #[test]
    fn deletes_notebook_files_and_reassigns_the_default() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = MobileState::new(directory.path().to_path_buf()).expect("mobile state");
        state.ensure_local_notebook().expect("default notebook");
        let original = read_memo_file(&state)
            .read_notebook_configs()
            .expect("notebook configs")
            .into_iter()
            .next()
            .expect("default config");
        let second_id = "nb_second".to_string();
        let second_dir = state.notebook_dir(&second_id);
        std::fs::create_dir_all(&second_dir).expect("second directory");
        std::fs::write(second_dir.join("memo.md"), "note").expect("second memo");
        let memo_file = read_memo_file(&state);
        memo_file
            .write_notebook_configs(&[
                original.clone(),
                NotebookConfig {
                    id: second_id.clone(),
                    name: "Second".to_string(),
                    icon: None,
                    path: format!("{}/", second_dir.display()),
                    is_default: false,
                    sort: original.sort + 10,
                    created_at: original.created_at + 1,
                    updated_at: original.updated_at + 1,
                },
            ])
            .expect("second config");
        drop(memo_file);

        assert!(delete_local_notebook(&state, &original.id).expect("delete notebook"));
        let remaining = read_memo_file(&state)
            .read_notebook_configs()
            .expect("remaining config");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, second_id);
        assert!(remaining[0].is_default);
        assert!(!state.notebook_dir(&original.id).exists());
        assert!(second_dir.exists());
    }

    #[test]
    fn refuses_to_delete_the_last_notebook() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = MobileState::new(directory.path().to_path_buf()).expect("mobile state");
        state.ensure_local_notebook().expect("default notebook");
        let id = read_memo_file(&state)
            .read_notebook_configs()
            .expect("notebook configs")[0]
            .id
            .clone();

        assert_eq!(
            delete_local_notebook(&state, &id).unwrap_err(),
            "CANNOT_DELETE_LAST_NOTEBOOK"
        );
        assert!(state.notebook_dir(&id).is_dir());
    }
}
