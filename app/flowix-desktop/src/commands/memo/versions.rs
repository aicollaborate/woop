// ==================== Versions ====================
//
// Memo version history IPC. Distinct from `creates` because versions are
// immutable snapshots keyed by `(memo_id, version_id)` rather than mutating
// the live memo state.

use std::fs;

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use flowix_core::memo_file::{MemoVersionMeta, MemoVersionSource};
use flowix_core::MemoService;

use crate::app::state::AppState;
use crate::commands::helpers::start_security_bookmark_access;
use crate::watcher::runtime::mark_self_write_for;

use super::helpers::*;
use super::*;

#[tauri::command]
pub fn list_memo_versions(id: String, state: State<AppState>) -> Vec<MemoVersionMeta> {
    MemoService::new(&read_lock(&state.memo_file, "memo_file")).list_memo_versions(&id)
}

#[tauri::command]
pub fn read_memo_version(id: String, version_id: String, state: State<AppState>) -> Option<String> {
    MemoService::new(&read_lock(&state.memo_file, "memo_file")).read_memo_version(&id, &version_id)
}

#[tauri::command]
pub fn create_memo_version(
    id: String,
    source: Option<MemoVersionSource>,
    state: State<AppState>,
) -> Option<MemoVersionMeta> {
    let path = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .resolve_memo(&id)
        .ok()?
        .path;
    start_security_bookmark_access(&state, &path);
    let content = fs::read_to_string(path).ok()?;
    match MemoService::new(&read_lock(&state.memo_file, "memo_file")).create_memo_version(
        &id,
        &content,
        source.unwrap_or(MemoVersionSource::Manual),
    ) {
        Ok(version) => version,
        Err(e) => {
            eprintln!("[create_memo_version] failed for {id}: {e}");
            None
        }
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn restore_memo_version(
    id: String,
    version_id: String,
    expectedContent: Option<String>,
    state: State<AppState>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Option<WriteDocumentResult> {
    let target_content = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .read_memo_version(&id, &version_id)?;
    let before = read_memo_or_none(state.inner(), &id);
    let current_path = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .resolve_memo(&id)
        .ok()?
        .path;
    start_security_bookmark_access(&state, &current_path);
    let result = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        MemoService::new(&memo_file).save_memo_with_receipt(
            &id,
            &target_content,
            false,
            |resolved, current| {
                if expectedContent.as_deref().is_some_and(|expected| {
                    !cas_content_matches(current, expected, &target_content)
                }) {
                    return Err(flowix_core::FlowixError::Conflict(format!(
                        "memo {id} changed on disk"
                    )));
                }
                memo_file.create_memo_version(&id, current, MemoVersionSource::RestoreBackup)?;
                mark_self_write_for(&app, &resolved.path);
                Ok(())
            },
        )
    };
    match result {
        Ok(receipt) => {
            start_security_bookmark_access(&state, &receipt.edited.path);
            emit_saved_memo_receipt(state.inner(), &app, receipt, before, window.label())
        }
        Err(e) => {
            eprintln!("[restore_memo_version] restore failed for {id}: {e}");
            None
        }
    }
}

#[tauri::command]
pub fn delete_memo_version(id: String, version_id: String, state: State<AppState>) -> bool {
    MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .delete_memo_version(&id, &version_id)
}
