use std::path::{Path, PathBuf};

use flowix_core::memo_file::{Memo, Notebook};
use flowix_core::MemoService;
use flowix_sync::{CloudState, LocalChangeKind};
use serde::Serialize;
use tauri::{AppHandle, State};

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    notebooks: usize,
    uploaded: usize,
    deleted: usize,
    downloaded: usize,
    conflicts: usize,
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

#[tauri::command]
pub async fn mobile_initialize(state: State<'_, MobileState>) -> Result<CloudState, String> {
    let _guard = state.initialize_lock.lock().await;
    state.ensure_local_notebook()?;
    let current = state
        .cloud_sync
        .state()
        .map_err(|error| error.to_string())?;
    if !current.authenticated {
        if let Some(token) = state.load_refresh_token()? {
            match state.cloud_sync.restore(&token).await {
                Ok(outcome) => state.save_refresh_token(&outcome.refresh_token)?,
                Err(flowix_sync::SyncError::NotAuthenticated)
                | Err(flowix_sync::SyncError::Api { status: 401, .. }) => {
                    state.delete_refresh_token()?
                }
                Err(error) => {
                    eprintln!("mobile session restore deferred: {error}");
                }
            }
        }
    }
    let next = state
        .cloud_sync
        .state()
        .map_err(|error| error.to_string())?;
    let sync_allowed = cloud_sync_allowed(&next);
    let _ = state.cloud_sync.set_enabled(sync_allowed);
    if sync_allowed {
        let _ = crate::sync::bootstrap_and_sync(state.inner()).await;
    }
    state.cloud_sync.state().map_err(|error| error.to_string())
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

#[tauri::command]
pub async fn mobile_bootstrap_cloud(
    state: State<'_, MobileState>,
) -> Result<CloudSyncResult, String> {
    let cloud = state
        .cloud_sync
        .state()
        .map_err(|error| error.to_string())?;
    if !cloud_sync_allowed(&cloud) {
        return Err("CLOUD_MEMBERSHIP_REQUIRED".to_string());
    }
    let (notebooks, report) = crate::sync::bootstrap_and_sync(state.inner()).await?;
    Ok(CloudSyncResult {
        notebooks,
        uploaded: report.uploaded,
        deleted: report.deleted,
        downloaded: report.remote.len(),
        conflicts: 0,
    })
}

#[tauri::command]
pub async fn cloud_sync_now(
    _notebook_id: Option<String>,
    state: State<'_, MobileState>,
) -> Result<CloudSyncResult, String> {
    mobile_bootstrap_cloud(state).await
}

#[tauri::command]
pub fn get_notebooks(state: State<'_, MobileState>) -> Result<Vec<Notebook>, String> {
    read_memo_file(&state)
        .read_notebook_configs()
        .map(|configs| configs.into_iter().map(notebook_from_config).collect())
        .map_err(|error| error.to_string())
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
    crate::sync::schedule_sync(app);
    Ok(Some(WriteDocumentResult {
        path: edited.path.to_string_lossy().into_owned(),
        content: final_content,
    }))
}

#[tauri::command]
pub fn add_document(
    tag: Option<String>,
    notebook_id: Option<String>,
    state: State<'_, MobileState>,
    app: AppHandle,
) -> Result<Memo, String> {
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
    crate::sync::schedule_sync(app);
    Ok(memo)
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
