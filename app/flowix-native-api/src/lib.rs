//! Small C-compatible transport for the Swift client.
//!
//! This crate deliberately contains no Tauri dependency. The first version
//! exposes local notebook reads and writes; cloud sync and attachment APIs can
//! be added without making Swift depend on a WebView runtime.

use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, CStr, CString};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use chrono::Utc;
use flowix_core::memo_file::{
    atomic_write_bytes, merge_frontmatter, resolve_filename_conflict, sanitize_filename_component,
    IsMd, Memo, MemoFile, MergeOverrides, NotebookConfig,
};
use flowix_core::MemoService;
use flowix_sync::{
    collect_v2_attachments, LocalChangeKind, SyncManager, V2AccountSyncReport, V2LocalNote,
    V2LocalNotebook, V2RemoteApply,
};
use serde::Serialize;
use serde_json::json;

struct NativeStore {
    memo_file: MemoFile,
    data_dir: PathBuf,
    attachment_uploads: HashMap<String, PendingAttachmentUpload>,
    cloud_sync: SyncManager,
}

const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_ATTACHMENT_STORAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ATTACHMENT_CHUNK_BYTES: usize = 512 * 1024;

struct PendingAttachmentUpload {
    temporary_path: PathBuf,
    destination_path: PathBuf,
    expected_bytes: u64,
    written_bytes: u64,
}

static STORE: OnceLock<Mutex<Option<NativeStore>>> = OnceLock::new();

fn store_slot() -> &'static Mutex<Option<NativeStore>> {
    STORE.get_or_init(|| Mutex::new(None))
}

fn response<T: Serialize>(value: T) -> *mut c_char {
    let json = serde_json::to_string(&value).unwrap_or_else(|error| {
        serde_json::to_string(&json!({
            "ok": false,
            "error": format!("SERIALIZE_ERROR: {error}"),
        }))
        .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"SERIALIZE_ERROR\"}".to_string())
    });
    CString::new(json)
        .unwrap_or_else(|_| CString::new(r#"{"ok":false,"error":"INVALID_RESPONSE"}"#).unwrap())
        .into_raw()
}

fn error(message: impl Into<String>) -> *mut c_char {
    response(json!({ "ok": false, "error": message.into() }))
}

unsafe fn input(value: *const c_char) -> Result<String, String> {
    if value.is_null() {
        return Err("NULL_ARGUMENT".to_string());
    }
    CStr::from_ptr(value)
        .to_str()
        .map(str::to_owned)
        .map_err(|_| "INVALID_UTF8".to_string())
}

fn reconcile_notebook_paths(data_dir: &Path, memo_file: &MemoFile) -> Result<(), String> {
    let mut configs = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    let mut changed = false;
    for config in &mut configs {
        let path = data_dir.join("notebooks").join(&config.id);
        std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        let expected = format!("{}/", path.display());
        if config.path != expected {
            config.path = expected;
            changed = true;
        }
    }
    if changed {
        memo_file
            .write_notebook_configs(&configs)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn initialize_store(data_dir: PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let config_dir = data_dir.join("config");
    std::fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let memo_file = MemoFile::new(config_dir.clone());
    let mut configs = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;

    if configs.is_empty() {
        let id = format!("nb_{}", uuid::Uuid::now_v7());
        let path = data_dir.join("notebooks").join(&id);
        std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        let now = Utc::now().timestamp_millis();
        configs.push(NotebookConfig {
            id,
            name: "我的笔记".to_string(),
            icon: Some("📝".to_string()),
            path: format!("{}/", path.display()),
            is_default: true,
            sort: 10,
            created_at: now,
            updated_at: now,
        });
        memo_file
            .write_notebook_configs(&configs)
            .map_err(|error| error.to_string())?;
    }

    reconcile_notebook_paths(&data_dir, &memo_file)?;
    let current_id = configs.first().map(|config| config.id.clone());
    let mut memo_file = memo_file;
    memo_file.set_current_notebook(current_id);

    let cloud_sync = SyncManager::new(
        flowix_sync::DEFAULT_CLOUD_API_BASE,
        config_dir.join("sync.db"),
    )
    .map_err(|error| error.to_string())?;

    let mut slot = store_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    memo_file
        .seed_onboarding_docs()
        .map_err(|error| error.to_string())?;
    *slot = Some(NativeStore {
        memo_file,
        data_dir,
        attachment_uploads: HashMap::new(),
        cloud_sync,
    });
    Ok(())
}

fn with_store<T>(
    operation: impl FnOnce(&mut NativeStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut slot = store_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let store = slot
        .as_mut()
        .ok_or_else(|| "NATIVE_API_NOT_INITIALIZED".to_string())?;
    operation(store)
}

fn run_async<T, E: std::fmt::Display>(
    future: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, String> {
    let value = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?
        .block_on(future);
    value.map_err(|error| error.to_string())
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

fn write_cloud_attachments(
    base: &Path,
    attachments: &[flowix_sync::V2RemoteAttachment],
) -> Result<(), String> {
    let directory = base.join("attachments");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    for attachment in attachments {
        let filename = &attachment.metadata.filename;
        if Path::new(filename)
            .file_name()
            .and_then(|value| value.to_str())
            != Some(filename)
            || attachment.metadata.size_bytes
                != i64::try_from(attachment.content.len()).map_err(|_| "ATTACHMENT_TOO_LARGE")?
            || flowix_sync::v2_content_hash(&attachment.content) != attachment.metadata.content_hash
        {
            return Err(format!("CLOUD_ATTACHMENT_INVALID: {filename}"));
        }
        atomic_write_bytes(&directory.join(filename), &attachment.content)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_remote_notebooks(
    store: &mut NativeStore,
    remote: &[flowix_sync::CloudNotebook],
) -> Result<(), String> {
    let mut configs = store
        .memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    let mut changed = false;
    for notebook in remote {
        let path = store.data_dir.join("notebooks").join(&notebook.id);
        std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        if let Some(config) = configs.iter_mut().find(|config| config.id == notebook.id) {
            if config.name != notebook.name
                || config.icon != notebook.icon
                || config.sort != notebook.sort_order
            {
                config.name.clone_from(&notebook.name);
                config.icon.clone_from(&notebook.icon);
                config.sort = notebook.sort_order;
                config.updated_at = notebook.updated_at;
                changed = true;
            }
        } else {
            configs.push(NotebookConfig {
                id: notebook.id.clone(),
                name: notebook.name.clone(),
                icon: notebook.icon.clone(),
                path: format!("{}/", path.display()),
                is_default: configs.is_empty(),
                sort: notebook.sort_order,
                created_at: notebook.created_at,
                updated_at: notebook.updated_at,
            });
            changed = true;
        }
        store
            .cloud_sync
            .set_v2_notebook_enabled(
                &V2LocalNotebook {
                    id: notebook.id.clone(),
                    name: notebook.name.clone(),
                    icon: notebook.icon.clone(),
                    sort_order: notebook.sort_order,
                },
                true,
            )
            .map_err(|error| error.to_string())?;
    }
    if changed {
        configs.sort_by_key(|config| config.sort);
        store
            .memo_file
            .write_notebook_configs(&configs)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn enable_local_notebooks(store: &mut NativeStore) -> Result<(), String> {
    let state = store
        .cloud_sync
        .state()
        .map_err(|error| error.to_string())?;
    if !state.authenticated
        || !state
            .membership
            .as_ref()
            .is_some_and(|membership| membership.active && !membership.read_only)
    {
        return Ok(());
    }
    let configs = store
        .memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    for config in configs {
        store
            .cloud_sync
            .set_v2_notebook_enabled(
                &V2LocalNotebook {
                    id: config.id,
                    name: config.name,
                    icon: config.icon,
                    sort_order: config.sort,
                },
                true,
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn local_sync_snapshot(
    store: &mut NativeStore,
) -> Result<(Vec<V2LocalNotebook>, Vec<V2LocalNote>), String> {
    let enabled: HashSet<String> = store
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|notebook| notebook.notebook_id)
        .collect();
    let configs = store
        .memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    let mut notebooks = Vec::new();
    let mut notes = Vec::new();
    for config in configs
        .into_iter()
        .filter(|config| enabled.contains(&config.id))
    {
        for memo in store
            .memo_file
            .read_all_memos_for_notebook_id(Some(&config.id))
        {
            let path = store
                .data_dir
                .join("notebooks")
                .join(&config.id)
                .join(&memo.filename);
            let content = std::fs::read(&path)
                .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
            let attachments = collect_v2_attachments(
                &store
                    .data_dir
                    .join("notebooks")
                    .join(&config.id)
                    .join("attachments"),
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

fn apply_note_changes(
    store: &mut NativeStore,
    notebook_id: &str,
    changes: &[&V2RemoteApply],
) -> Result<(), String> {
    let _notebook = store
        .memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let base = store.data_dir.join("notebooks").join(notebook_id);
    std::fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    let mut occupied: Vec<String> = store
        .memo_file
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
            store
                .memo_file
                .delete_memo_result_for_notebook_id(notebook_id, note_id)
                .map_err(|error| error.to_string())?;
            continue;
        }
        let bytes = content
            .as_ref()
            .ok_or_else(|| format!("CLOUD_NOTE_CONTENT_MISSING: {note_id}"))?;
        let expected_hash = content_hash
            .as_deref()
            .ok_or_else(|| format!("CLOUD_NOTE_HASH_MISSING: {note_id}"))?;
        if flowix_sync::v2_content_hash(bytes) != expected_hash {
            return Err(format!("CLOUD_NOTE_HASH_MISMATCH: {note_id}"));
        }
        let markdown =
            std::str::from_utf8(bytes).map_err(|_| format!("CLOUD_NOTE_NOT_UTF8: {note_id}"))?;
        write_cloud_attachments(&base, attachments)?;
        let current = store
            .memo_file
            .read_memo_for_notebook_id(notebook_id, note_id);
        let old_path = current.as_ref().map(|memo| base.join(&memo.filename));
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
        let overrides: MergeOverrides =
            [("key".to_string(), note_id.clone())].into_iter().collect();
        let stamped = merge_frontmatter(markdown, &overrides);
        atomic_write_bytes(&desired_path, stamped.as_bytes()).map_err(|error| error.to_string())?;
        let memo = store
            .memo_file
            .register_existing_file_for_notebook_id(notebook_id, &desired_path)
            .map_err(|error| error.to_string())?;
        if memo.id != *note_id {
            return Err(format!("CLOUD_NOTE_ID_MISMATCH: {note_id}"));
        }
        if let Some(path) = old_path.filter(|path| path != &desired_path) {
            if path.exists() {
                std::fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn apply_sync_report(store: &mut NativeStore, report: &V2AccountSyncReport) -> Result<(), String> {
    let mut note_changes = HashMap::<String, Vec<&V2RemoteApply>>::new();
    let mut notebook_changes =
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
                notebook_changes.insert(
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
        apply_note_changes(store, &notebook_id, &changes)?;
    }
    if !notebook_changes.is_empty() {
        let mut configs = store
            .memo_file
            .read_notebook_configs()
            .map_err(|error| error.to_string())?;
        configs.retain(|config| {
            !notebook_changes
                .get(&config.id)
                .is_some_and(|(_, _, _, deleted)| *deleted)
        });
        for config in &mut configs {
            if let Some((Some(name), icon, Some(sort), false)) = notebook_changes.get(&config.id) {
                config.name.clone_from(name);
                config.icon.clone_from(icon);
                config.sort = *sort;
            }
        }
        configs.sort_by_key(|config| config.sort);
        store
            .memo_file
            .write_notebook_configs(&configs)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySnapshot {
    notebooks: Vec<NotebookSnapshot>,
    selected_notebook_id: Option<String>,
    tags: Vec<TagSnapshot>,
    memos: Vec<Memo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotebookSnapshot {
    id: String,
    name: String,
    icon: String,
    memo_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TagSnapshot {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenMemoResponse {
    ok: bool,
    memo: Memo,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteDocumentResponse {
    ok: bool,
    id: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateMemoResponse {
    ok: bool,
    memo: Memo,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadStartResponse {
    ok: bool,
    upload_id: String,
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
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let mut total = 0_u64;
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

fn attachment_storage_bytes(store: &NativeStore) -> Result<u64, String> {
    let configs = store
        .memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    configs.into_iter().try_fold(0_u64, |total, notebook| {
        let path = store
            .data_dir
            .join("notebooks")
            .join(notebook.id)
            .join("attachments");
        Ok(total.saturating_add(directory_size(&path)?))
    })
}

fn begin_attachment_upload(
    file_name: String,
    mime_type: String,
    size_bytes: u64,
    memo_id: String,
    store: &mut NativeStore,
) -> Result<String, String> {
    if size_bytes == 0 || size_bytes > MAX_ATTACHMENT_BYTES {
        return Err("ATTACHMENT_SIZE_LIMIT_EXCEEDED".to_string());
    }
    if !valid_attachment_mime_type(&mime_type) {
        return Err("INVALID_ATTACHMENT_MIME_TYPE".to_string());
    }

    let document = MemoService::new(&store.memo_file)
        .get_memo(&memo_id)
        .map_err(|error| error.to_string())?;
    let attachment_dir = store
        .data_dir
        .join("notebooks")
        .join(document.notebook.id)
        .join("attachments");
    std::fs::create_dir_all(&attachment_dir).map_err(|error| error.to_string())?;
    let reserved_bytes = store
        .attachment_uploads
        .values()
        .fold(0_u64, |total, upload| {
            total.saturating_add(upload.expected_bytes)
        });
    if attachment_storage_bytes(store)?
        .saturating_add(reserved_bytes)
        .saturating_add(size_bytes)
        > MAX_ATTACHMENT_STORAGE_BYTES
    {
        return Err("ATTACHMENT_STORAGE_LIMIT_EXCEEDED".to_string());
    }

    let reserved_paths = store
        .attachment_uploads
        .values()
        .map(|upload| upload.destination_path.clone())
        .collect::<Vec<_>>();
    let destination_path = unique_attachment_path(&attachment_dir, &file_name, &reserved_paths)?;
    let upload_id = uuid::Uuid::now_v7().to_string();
    let upload_dir = store.data_dir.join(".uploads");
    std::fs::create_dir_all(&upload_dir).map_err(|error| error.to_string())?;
    let temporary_path = upload_dir.join(format!("{upload_id}.part"));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| error.to_string())?;
    store.attachment_uploads.insert(
        upload_id.clone(),
        PendingAttachmentUpload {
            temporary_path,
            destination_path,
            expected_bytes: size_bytes,
            written_bytes: 0,
        },
    );
    Ok(upload_id)
}

fn write_attachment_chunk(
    upload_id: String,
    content: String,
    store: &mut NativeStore,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|error| format!("INVALID_ATTACHMENT_CONTENT: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_CHUNK_BYTES {
        return Err("ATTACHMENT_CHUNK_SIZE_INVALID".to_string());
    }
    let upload = store
        .attachment_uploads
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

fn finish_attachment_upload(upload_id: String, store: &mut NativeStore) -> Result<String, String> {
    let upload = store
        .attachment_uploads
        .remove(&upload_id)
        .ok_or_else(|| "ATTACHMENT_UPLOAD_NOT_FOUND".to_string())?;
    if upload.written_bytes != upload.expected_bytes {
        let _ = std::fs::remove_file(&upload.temporary_path);
        return Err("ATTACHMENT_UPLOAD_SIZE_MISMATCH".to_string());
    }
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
    result
}

fn cancel_attachment_upload(upload_id: String, store: &mut NativeStore) {
    if let Some(upload) = store.attachment_uploads.remove(&upload_id) {
        let _ = std::fs::remove_file(upload.temporary_path);
    }
}

#[no_mangle]
/// # Safety
/// `data_dir` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_initialize(data_dir: *const c_char) -> *mut c_char {
    let data_dir = match unsafe { input(data_dir) } {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        Ok(_) => return error("DATA_DIR_EMPTY"),
        Err(message) => return error(message),
    };
    match initialize_store(data_dir) {
        Ok(()) => response(json!({ "ok": true })),
        Err(message) => error(message),
    }
}

#[no_mangle]
pub extern "C" fn flowix_native_cloud_state() -> *mut c_char {
    match with_store(|store| store.cloud_sync.state().map_err(|error| error.to_string())) {
        Ok(state) => response(json!({ "ok": true, "state": state })),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `email` and `password` must be valid, NUL-terminated UTF-8 C strings for this call.
pub unsafe extern "C" fn flowix_native_cloud_login(
    email: *const c_char,
    password: *const c_char,
) -> *mut c_char {
    let email = match unsafe { input(email) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let password = match unsafe { input(password) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let manager = match with_store(|store| Ok(store.cloud_sync.clone())) {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    match run_async(manager.login(email.trim(), &password)) {
        Ok(outcome) => {
            let enabled = outcome
                .state
                .membership
                .as_ref()
                .is_some_and(|membership| membership.active && !membership.read_only);
            let state = manager
                .set_enabled(enabled)
                .map_err(|error| error.to_string());
            match state {
                Ok(state) => response(
                    json!({ "ok": true, "state": state, "refreshToken": outcome.refresh_token }),
                ),
                Err(message) => error(message),
            }
        }
        Err(message) => error(message.to_string()),
    }
}

#[no_mangle]
/// # Safety
/// `refresh_token` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_cloud_restore(refresh_token: *const c_char) -> *mut c_char {
    let refresh_token = match unsafe { input(refresh_token) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let manager = match with_store(|store| Ok(store.cloud_sync.clone())) {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    match run_async(manager.restore(&refresh_token)) {
        Ok(outcome) => {
            let enabled = outcome
                .state
                .membership
                .as_ref()
                .is_some_and(|membership| membership.active && !membership.read_only);
            let state = manager
                .set_enabled(enabled)
                .map_err(|error| error.to_string());
            match state {
                Ok(state) => response(
                    json!({ "ok": true, "state": state, "refreshToken": outcome.refresh_token }),
                ),
                Err(message) => error(message),
            }
        }
        Err(message) => error(message.to_string()),
    }
}

#[no_mangle]
pub extern "C" fn flowix_native_cloud_logout() -> *mut c_char {
    let manager = match with_store(|store| Ok(store.cloud_sync.clone())) {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    match run_async(manager.logout()) {
        Ok(()) => match manager.state() {
            Ok(state) => response(json!({ "ok": true, "state": state })),
            Err(message) => error(message.to_string()),
        },
        Err(message) => error(message.to_string()),
    }
}

#[no_mangle]
pub extern "C" fn flowix_native_cloud_list_notebooks() -> *mut c_char {
    let manager = match with_store(|store| Ok(store.cloud_sync.clone())) {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    match run_async(manager.v2_remote_notebooks()) {
        Ok(notebooks) => response(json!({ "ok": true, "notebooks": notebooks })),
        Err(message) => error(message),
    }
}

#[no_mangle]
pub extern "C" fn flowix_native_cloud_refresh_membership() -> *mut c_char {
    let manager = match with_store(|store| Ok(store.cloud_sync.clone())) {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    match run_async(manager.refresh_membership()) {
        Ok(membership) => {
            let enabled = membership.active && !membership.read_only;
            match manager.set_enabled(enabled).and_then(|_| manager.state()) {
                Ok(state) => response(json!({
                    "ok": true,
                    "membership": membership,
                    "state": state,
                })),
                Err(message) => error(message.to_string()),
            }
        }
        Err(message) => error(message),
    }
}

#[no_mangle]
pub extern "C" fn flowix_native_cloud_sync_now() -> *mut c_char {
    let manager = match with_store(|store| Ok(store.cloud_sync.clone())) {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let remote_notebooks = match run_async(manager.v2_remote_notebooks()) {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    if let Err(message) = with_store(|store| ensure_remote_notebooks(store, &remote_notebooks)) {
        return error(message);
    }
    if let Err(message) = with_store(enable_local_notebooks) {
        return error(message);
    }
    let (notebooks, notes) = match with_store(local_sync_snapshot) {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let report = match run_async(manager.sync_v2_account(notebooks, notes)) {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    if let Err(message) = with_store(|store| {
        apply_sync_report(store, &report)?;
        store
            .cloud_sync
            .complete_v2_account_sync(&report)
            .map_err(|error| error.to_string())
    }) {
        return error(message);
    }
    response(json!({
        "ok": true,
        "notebooks": remote_notebooks.len(),
        "uploaded": report.uploaded,
        "deleted": report.deleted,
        "downloaded": report.remote.len(),
        "conflicts": 0,
    }))
}

#[no_mangle]
pub extern "C" fn flowix_native_library_snapshot() -> *mut c_char {
    let result = with_store(|store| {
        let configs = store
            .memo_file
            .read_notebook_configs()
            .map_err(|error| error.to_string())?;
        let selected_notebook_id = store
            .memo_file
            .current_notebook_id_value()
            .filter(|id| configs.iter().any(|config| config.id == *id))
            .or_else(|| configs.first().map(|config| config.id.clone()));
        let notebooks = configs
            .iter()
            .map(|config| NotebookSnapshot {
                id: config.id.clone(),
                name: config.name.clone(),
                icon: config.icon.clone().unwrap_or_default(),
                memo_count: store
                    .memo_file
                    .read_all_memos_for_notebook_id(Some(&config.id))
                    .len(),
            })
            .collect();
        let memos = selected_notebook_id
            .as_deref()
            .map(|id| {
                store.memo_file.read_all_memos_filtered_for_notebook_id(
                    Some(id),
                    "all",
                    "updatedAt",
                    None,
                )
            })
            .unwrap_or_default();
        let tags = selected_notebook_id
            .as_deref()
            .map(|id| {
                store
                    .memo_file
                    .derived_tags_for_notebook_id(Some(id))
                    .into_iter()
                    .map(|tag| TagSnapshot {
                        id: tag.id,
                        name: tag.name,
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(LibrarySnapshot {
            notebooks,
            selected_notebook_id,
            tags,
            memos,
        })
    });
    match result {
        Ok(value) => response(json!({ "ok": true, "snapshot": value })),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// When non-null, `notebook_id` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_set_current_notebook(
    notebook_id: *const c_char,
) -> *mut c_char {
    let notebook_id = if notebook_id.is_null() {
        None
    } else {
        match unsafe { input(notebook_id) } {
            Ok(value) if !value.trim().is_empty() => Some(value),
            Ok(_) => return error("NOTEBOOK_ID_EMPTY"),
            Err(message) => return error(message),
        }
    };
    let result = with_store(|store| {
        if let Some(id) = notebook_id.as_deref() {
            let exists = store
                .memo_file
                .read_notebook_configs()
                .map_err(|error| error.to_string())?
                .iter()
                .any(|config| config.id == id);
            if !exists {
                return Err("NOTEBOOK_NOT_FOUND".to_string());
            }
        }
        store.memo_file.set_current_notebook(notebook_id);
        Ok(())
    });
    match result {
        Ok(()) => response(json!({ "ok": true })),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `name` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_create_notebook(name: *const c_char) -> *mut c_char {
    let name = match unsafe { input(name) } {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        Ok(_) => return error("INVALID_NAME"),
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        let mut configs = store
            .memo_file
            .read_notebook_configs()
            .map_err(|error| error.to_string())?;
        let id = format!("nb_{}", uuid::Uuid::now_v7());
        let path = store.data_dir.join("notebooks").join(&id);
        std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        let now = Utc::now().timestamp_millis();
        let config = NotebookConfig {
            id,
            name,
            icon: None,
            path: format!("{}/", path.display()),
            is_default: false,
            sort: configs.iter().map(|config| config.sort).max().unwrap_or(0) + 10,
            created_at: now,
            updated_at: now,
        };
        let created = config.clone();
        configs.push(config);
        store
            .memo_file
            .write_notebook_configs(&configs)
            .map_err(|error| error.to_string())?;
        let cloud_state = store
            .cloud_sync
            .state()
            .map_err(|error| error.to_string())?;
        if cloud_state.authenticated
            && cloud_state
                .membership
                .as_ref()
                .is_some_and(|membership| membership.active && !membership.read_only)
        {
            store
                .cloud_sync
                .set_v2_notebook_enabled(
                    &V2LocalNotebook {
                        id: created.id,
                        name: created.name,
                        icon: created.icon,
                        sort_order: created.sort,
                    },
                    true,
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    });
    match result {
        Ok(()) => response(json!({ "ok": true })),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `notebook_id` and `name` must be valid, NUL-terminated UTF-8 C strings for this call.
pub unsafe extern "C" fn flowix_native_rename_notebook(
    notebook_id: *const c_char,
    name: *const c_char,
) -> *mut c_char {
    let notebook_id = match unsafe { input(notebook_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let name = match unsafe { input(name) } {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        Ok(_) => return error("INVALID_NAME"),
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        let mut configs = store
            .memo_file
            .read_notebook_configs()
            .map_err(|error| error.to_string())?;
        let config = configs
            .iter_mut()
            .find(|config| config.id == notebook_id)
            .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
        config.name = name;
        config.updated_at = Utc::now().timestamp_millis();
        let notebook = V2LocalNotebook {
            id: config.id.clone(),
            name: config.name.clone(),
            icon: config.icon.clone(),
            sort_order: config.sort,
        };
        store
            .memo_file
            .write_notebook_configs(&configs)
            .map_err(|error| error.to_string())?;
        store
            .cloud_sync
            .record_v2_notebook_change(&notebook)
            .map_err(|error| error.to_string())?;
        Ok(())
    });
    match result {
        Ok(()) => response(json!({ "ok": true })),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `notebook_id` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_delete_notebook(notebook_id: *const c_char) -> *mut c_char {
    let notebook_id = match unsafe { input(notebook_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        let mut configs = store
            .memo_file
            .read_notebook_configs()
            .map_err(|error| error.to_string())?;
        if configs.len() <= 1 {
            return Err("CANNOT_DELETE_LAST_NOTEBOOK".to_string());
        }
        let index = configs
            .iter()
            .position(|config| config.id == notebook_id)
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
        store
            .memo_file
            .write_notebook_configs(&configs)
            .map_err(|error| error.to_string())?;
        store
            .cloud_sync
            .record_v2_notebook_delete(&notebook_id)
            .map_err(|error| error.to_string())?;
        let directory = store.data_dir.join("notebooks").join(&notebook_id);
        if directory.exists() {
            std::fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
        }
        if store.memo_file.current_notebook_id_value().as_deref() == Some(notebook_id.as_str()) {
            store
                .memo_file
                .set_current_notebook(configs.first().map(|config| config.id.clone()));
        }
        Ok(())
    });
    match result {
        Ok(()) => response(json!({ "ok": true })),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `notebook_id`, `title`, and `content` must be valid, NUL-terminated UTF-8 C strings for this call.
pub unsafe extern "C" fn flowix_native_create_memo(
    notebook_id: *const c_char,
    title: *const c_char,
    content: *const c_char,
) -> *mut c_char {
    let notebook_id = match unsafe { input(notebook_id) } {
        Ok(value) if !value.trim().is_empty() => value,
        Ok(_) => return error("NOTEBOOK_ID_EMPTY"),
        Err(message) => return error(message),
    };
    let title = match unsafe { input(title) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let content = match unsafe { input(content) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        let mut service = MemoService::new(&store.memo_file);
        let created = service
            .create_memo_named(Some(&notebook_id), &title, &content)
            .map_err(|error| error.to_string())?;
        let final_content =
            std::fs::read_to_string(&created.path).map_err(|error| error.to_string())?;
        store
            .cloud_sync
            .record_v2_local_change(
                &notebook_id,
                &created.memo.id,
                LocalChangeKind::Put,
                &flowix_sync::v2_content_hash(final_content.as_bytes()),
            )
            .map_err(|error| error.to_string())?;
        Ok(CreateMemoResponse {
            ok: true,
            memo: created.memo,
            content: final_content,
        })
    });
    match result {
        Ok(value) => response(value),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `memo_id` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_delete_memo(memo_id: *const c_char) -> *mut c_char {
    let memo_id = match unsafe { input(memo_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        let mut service = MemoService::new(&store.memo_file);
        let current = service
            .get_memo(&memo_id)
            .map_err(|error| error.to_string())?;
        let deleted = service
            .delete_memo(&memo_id)
            .map_err(|error| error.to_string())?;
        if deleted.file_removed {
            store
                .cloud_sync
                .record_v2_local_change(&current.notebook.id, &memo_id, LocalChangeKind::Delete, "")
                .map_err(|error| error.to_string())?;
        }
        Ok(deleted.file_removed)
    });
    match result {
        Ok(deleted) => response(json!({ "ok": true, "deleted": deleted })),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `memo_id` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_set_memo_favorited(
    memo_id: *const c_char,
    favorited: bool,
) -> *mut c_char {
    let memo_id = match unsafe { input(memo_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        let mut service = MemoService::new(&store.memo_file);
        let mut document = service
            .get_memo(&memo_id)
            .map_err(|error| error.to_string())?;
        document.entry.favorited = favorited;
        document.entry.updated_at = Utc::now().timestamp_millis();
        let memo = MemoFile::index_entry_to_memo(&document.entry);
        service
            .sync_memo_metadata(&memo)
            .map_err(|error| error.to_string())?;
        store
            .cloud_sync
            .record_v2_local_change(
                &document.notebook.id,
                &memo_id,
                LocalChangeKind::Put,
                &flowix_sync::v2_content_hash(document.body.as_bytes()),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    });
    match result {
        Ok(()) => response(json!({ "ok": true })),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `memo_id` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_open_memo(memo_id: *const c_char) -> *mut c_char {
    let memo_id = match unsafe { input(memo_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        let mut service = MemoService::new(&store.memo_file);
        let document = service
            .get_memo(&memo_id)
            .map_err(|error| error.to_string())?;
        let memo = MemoFile::index_entry_to_memo(&document.entry);
        Ok(OpenMemoResponse {
            ok: true,
            memo,
            content: document.body,
        })
    });
    match result {
        Ok(value) => response(value),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// All string pointers must be valid, NUL-terminated UTF-8 C strings for this call; `expected_content` may be null.
pub unsafe extern "C" fn flowix_native_write_document(
    memo_id: *const c_char,
    content: *const c_char,
    expected_content: *const c_char,
) -> *mut c_char {
    let memo_id = match unsafe { input(memo_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let content = match unsafe { input(content) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let expected_content = if expected_content.is_null() {
        None
    } else {
        match unsafe { input(expected_content) } {
            Ok(value) => Some(value),
            Err(message) => return error(message),
        }
    };

    let result = with_store(|store| {
        let mut service = MemoService::new(&store.memo_file);
        let current = service
            .get_memo(&memo_id)
            .map_err(|error| error.to_string())?;
        if expected_content
            .as_deref()
            .is_some_and(|expected| expected != current.body)
        {
            return Err("CONFLICT".to_string());
        }
        let edited = service
            .save_memo(&memo_id, &content)
            .map_err(|error| error.to_string())?;
        let final_content =
            std::fs::read_to_string(&edited.path).map_err(|error| error.to_string())?;
        store
            .cloud_sync
            .record_v2_local_change(
                &current.notebook.id,
                &edited.id,
                LocalChangeKind::Put,
                &flowix_sync::v2_content_hash(final_content.as_bytes()),
            )
            .map_err(|error| error.to_string())?;
        Ok(WriteDocumentResponse {
            ok: true,
            id: edited.id,
            content: final_content,
        })
    });
    match result {
        Ok(value) => response(value),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// All string pointers must be valid, NUL-terminated UTF-8 C strings for this call.
pub unsafe extern "C" fn flowix_native_begin_attachment_upload(
    file_name: *const c_char,
    mime_type: *const c_char,
    size_bytes: u64,
    memo_id: *const c_char,
) -> *mut c_char {
    let file_name = match unsafe { input(file_name) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let mime_type = match unsafe { input(mime_type) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let memo_id = match unsafe { input(memo_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        let upload_id = begin_attachment_upload(file_name, mime_type, size_bytes, memo_id, store)?;
        Ok(AttachmentUploadStartResponse {
            ok: true,
            upload_id,
        })
    });
    match result {
        Ok(value) => response(value),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `upload_id` and `content` must be valid, NUL-terminated UTF-8 C strings for this call.
pub unsafe extern "C" fn flowix_native_write_attachment_chunk(
    upload_id: *const c_char,
    content: *const c_char,
) -> *mut c_char {
    let upload_id = match unsafe { input(upload_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let content = match unsafe { input(content) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        write_attachment_chunk(upload_id, content, store)?;
        Ok(json!({ "ok": true }))
    });
    match result {
        Ok(value) => response(value),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `upload_id` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_finish_attachment_upload(
    upload_id: *const c_char,
) -> *mut c_char {
    let upload_id = match unsafe { input(upload_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        let path = finish_attachment_upload(upload_id, store)?;
        Ok(json!({ "ok": true, "storageKey": path }))
    });
    match result {
        Ok(value) => response(value),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `upload_id` must be a valid, NUL-terminated UTF-8 C string for this call.
pub unsafe extern "C" fn flowix_native_cancel_attachment_upload(
    upload_id: *const c_char,
) -> *mut c_char {
    let upload_id = match unsafe { input(upload_id) } {
        Ok(value) => value,
        Err(message) => return error(message),
    };
    let result = with_store(|store| {
        cancel_attachment_upload(upload_id, store);
        Ok(json!({ "ok": true }))
    });
    match result {
        Ok(value) => response(value),
        Err(message) => error(message),
    }
}

#[no_mangle]
/// # Safety
/// `value` must be a non-null pointer returned by this library that has not already been freed.
pub unsafe extern "C" fn flowix_native_free_string(value: *mut c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::CString;

    use serde_json::Value;

    use super::*;

    #[test]
    fn initialize_and_read_empty_library() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = CString::new(directory.path().to_string_lossy().as_bytes()).unwrap();
        let result = unsafe { flowix_native_initialize(path.as_ptr()) };
        let json = unsafe { CStr::from_ptr(result) }
            .to_str()
            .unwrap()
            .to_string();
        unsafe {
            flowix_native_free_string(result);
        }
        assert!(json.contains("\"ok\":true"));

        let snapshot = flowix_native_library_snapshot();
        let json = unsafe { CStr::from_ptr(snapshot) }
            .to_str()
            .unwrap()
            .to_string();
        unsafe {
            flowix_native_free_string(snapshot);
        }
        let snapshot: Value = serde_json::from_str(&json).unwrap();
        assert!(json.contains("我的笔记"));
        let notebook_id = snapshot["snapshot"]["selectedNotebookId"]
            .as_str()
            .unwrap()
            .to_owned();

        let notebook = CString::new(notebook_id).unwrap();
        let title = CString::new("FFI smoke test").unwrap();
        let content = CString::new("# FFI smoke test\n\nbody").unwrap();
        let created = unsafe {
            flowix_native_create_memo(notebook.as_ptr(), title.as_ptr(), content.as_ptr())
        };
        let created_json = unsafe { CStr::from_ptr(created) }
            .to_str()
            .unwrap()
            .to_owned();
        unsafe {
            flowix_native_free_string(created);
        }
        let created: Value = serde_json::from_str(&created_json).unwrap();
        assert_eq!(created["ok"], true);
        let memo_id = created["memo"]["id"].as_str().unwrap().to_owned();

        let memo = CString::new(memo_id.clone()).unwrap();
        let favorite = unsafe { flowix_native_set_memo_favorited(memo.as_ptr(), true) };
        let favorite_json = unsafe { CStr::from_ptr(favorite) }
            .to_str()
            .unwrap()
            .to_owned();
        unsafe {
            flowix_native_free_string(favorite);
        }
        assert!(favorite_json.contains("\"ok\":true"));

        let deleted = unsafe { flowix_native_delete_memo(memo.as_ptr()) };
        let deleted_json = unsafe { CStr::from_ptr(deleted) }
            .to_str()
            .unwrap()
            .to_owned();
        unsafe {
            flowix_native_free_string(deleted);
        }
        assert!(deleted_json.contains("\"deleted\":true"));
    }
}
