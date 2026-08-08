use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine;
use flowix_core::memo_file::{Memo, Notebook};
use flowix_core::MemoService;
use flowix_sync::{CloudState, LocalChangeKind, V2LocalNotebook};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{cloud_sync_allowed, read_memo_file, MobileState};

#[derive(Serialize)]
pub struct MemoListResponse {
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

fn notebook_from_config(config: flowix_core::memo_file::NotebookConfig) -> Notebook {
    Notebook {
        id: config.id,
        name: config.name,
        icon: config.icon.unwrap_or_default(),
        path: config.path,
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

fn unique_attachment_path(directory: &Path, name: &str) -> Result<PathBuf, String> {
    let file_name = safe_attachment_file_name(name);
    let candidate = directory.join(&file_name);
    if !candidate.starts_with(directory) {
        return Err("INVALID_ATTACHMENT_NAME".to_string());
    }
    if !candidate.exists() {
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
        if !candidate.exists() {
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
        .map(|configs| configs.into_iter().map(notebook_from_config).collect())
        .map_err(|error| error.to_string())
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
    Ok(notebook_from_config(config))
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
    Ok(notebook_from_config(updated))
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
        Err(flowix_core::FlowixError::NotFound(_)) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let path = document.path.to_string_lossy().into_owned();
    let notebook_path = document.notebook.path.clone();
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
            PathBuf::from(notebook.path)
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
    drop(memo_file);
    drop(mutation_guard);
    crate::sync::schedule_sync(app);
    Ok(Some(WriteDocumentResult {
        path: edited.path.to_string_lossy().into_owned(),
        content: final_content,
    }))
}

/// Stores browser-picked content under the owning memo's notebook. The client
/// only supplies bytes and a display name, so it cannot write outside its own
/// notebook attachment directory.
#[tauri::command]
#[allow(non_snake_case)]
pub fn mobile_save_attachment_content(
    content: String,
    fileName: String,
    memoId: String,
    state: State<'_, MobileState>,
) -> Result<String, String> {
    let notebook_id = notebook_id_for_memo(&state, &memoId)?;
    let memo_file = read_memo_file(&state);
    let notebook = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|notebook| notebook.id == notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    drop(memo_file);

    let attachment_dir = PathBuf::from(notebook.path).join("attachments");
    std::fs::create_dir_all(&attachment_dir).map_err(|error| error.to_string())?;
    let destination = unique_attachment_path(&attachment_dir, &fileName)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|error| format!("INVALID_ATTACHMENT_CONTENT: {error}"))?;
    std::fs::write(&destination, bytes).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().into_owned())
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
