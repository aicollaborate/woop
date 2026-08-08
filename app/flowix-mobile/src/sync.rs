use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use flowix_core::memo_file::{
    atomic_write_bytes, merge_frontmatter, resolve_filename_conflict, sanitize_filename_component,
    IsMd, MergeOverrides, NotebookConfig,
};
use flowix_sync::{
    collect_v2_attachments, v2_content_hash, V2AccountSyncReport, V2LocalNote, V2LocalNotebook, V2RemoteApply,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::{read_memo_file, MobileState};

fn enable_local_notebooks(state: &MobileState) -> Result<(), String> {
    let configs = read_memo_file(state)
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    for config in configs {
        let already_enabled = state
            .cloud_sync
            .v2_notebook(&config.id)
            .map_err(|error| error.to_string())?
            .is_some_and(|notebook| notebook.enabled);
        if already_enabled {
            continue;
        }
        state
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
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    for attachment in attachments {
        let filename = &attachment.metadata.filename;
        if Path::new(filename).file_name().and_then(|value| value.to_str()) != Some(filename)
            || attachment.metadata.size_bytes != i64::try_from(attachment.content.len()).map_err(|_| "ATTACHMENT_TOO_LARGE")?
            || v2_content_hash(&attachment.content) != attachment.metadata.content_hash
        {
            return Err(format!("CLOUD_ATTACHMENT_INVALID: {filename}"));
        }
        atomic_write_bytes(&directory.join(filename), &attachment.content).map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn ensure_remote_notebooks(state: &MobileState) -> Result<usize, String> {
    let remote = state
        .cloud_sync
        .v2_remote_notebooks()
        .await
        .map_err(|error| error.to_string())?;
    state.persist_rotated_refresh_token()?;

    let memo_file = read_memo_file(state);
    let mut configs = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    let mut changed = false;

    for notebook in &remote {
        let path = state.notebook_dir(&notebook.id);
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
    }

    if changed {
        configs.sort_by_key(|config| config.sort);
        memo_file
            .write_notebook_configs(&configs)
            .map_err(|error| error.to_string())?;
    }
    drop(memo_file);

    for notebook in &remote {
        state
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

    Ok(remote.len())
}

fn account_snapshot(
    state: &MobileState,
) -> Result<(Vec<V2LocalNotebook>, Vec<V2LocalNote>), String> {
    let enabled: HashSet<String> = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|notebook| notebook.notebook_id)
        .collect();
    let memo_file = read_memo_file(state);
    let configs = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
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

fn apply_note_changes(
    state: &MobileState,
    notebook_id: &str,
    changes: &[&V2RemoteApply],
) -> Result<(), String> {
    let memo_file = read_memo_file(state);
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let base = PathBuf::from(&notebook.path);
    std::fs::create_dir_all(&base).map_err(|error| error.to_string())?;
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

        // A local edit may land while the network request is in flight. Its
        // dirty generation must win; applying the pulled server revision here
        // would silently overwrite the newer local file.
        if state
            .cloud_sync
            .has_pending_v2_note_change(note_id)
            .map_err(|error| error.to_string())?
        {
            continue;
        }

        if *deleted {
            memo_file
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
        if v2_content_hash(bytes) != expected_hash {
            return Err(format!("CLOUD_NOTE_HASH_MISMATCH: {note_id}"));
        }
        let markdown =
            std::str::from_utf8(bytes).map_err(|_| format!("CLOUD_NOTE_NOT_UTF8: {note_id}"))?;
        write_cloud_attachments(&base, attachments)?;
        let current = memo_file.read_memo_for_notebook_id(notebook_id, note_id);
        if current.is_none() {
            if let Some(location) = memo_file
                .resolve_memo_location(note_id)
                .map_err(|error| error.to_string())?
            {
                return Err(format!(
                    "CLOUD_NOTE_ID_COLLISION: {note_id} belongs to {}",
                    location.notebook.id
                ));
            }
        }
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
        let memo = memo_file
            .register_existing_file_for_notebook_id(notebook_id, &desired_path)
            .map_err(|error| error.to_string())?;
        if memo.id != *note_id {
            return Err(format!(
                "CLOUD_NOTE_ID_MISMATCH: expected {note_id}, got {}",
                memo.id
            ));
        }
        if let Some(path) = old_path.filter(|path| path != &desired_path) {
            if path.exists() {
                std::fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn apply_report(state: &MobileState, report: &V2AccountSyncReport) -> Result<(), String> {
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
        apply_note_changes(state, &notebook_id, &changes)?;
    }

    if !notebook_changes.is_empty() {
        let memo_file = read_memo_file(state);
        let mut configs = memo_file
            .read_notebook_configs()
            .map_err(|error| error.to_string())?;
        let before_len = configs.len();
        configs.retain(|config| {
            !notebook_changes
                .get(&config.id)
                .is_some_and(|(_, _, _, deleted)| *deleted)
        });
        let mut changed = configs.len() != before_len;
        for config in &mut configs {
            let Some((name, icon, sort, deleted)) = notebook_changes.get(&config.id) else {
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
            if let Some(sort) = sort {
                if config.sort != *sort {
                    config.sort = *sort;
                    changed = true;
                }
            }
        }
        if changed {
            configs.sort_by_key(|config| config.sort);
            memo_file
                .write_notebook_configs(&configs)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub async fn sync_account(state: &MobileState) -> Result<V2AccountSyncReport, String> {
    let _guard = state.sync_lock.lock().await;
    let (notebooks, notes) = account_snapshot(state)?;
    let report_result = state.cloud_sync.sync_v2_account(notebooks, notes).await;
    // Refresh token rotation can happen before a later network or apply error.
    // Persist it on both paths so the next app launch never revives a stale
    // token that the server has already invalidated.
    state.persist_rotated_refresh_token()?;
    let report = report_result.map_err(|error| error.to_string())?;
    let mutation_guard = state.lock_mutations();
    apply_report(state, &report)?;
    state
        .cloud_sync
        .complete_v2_account_sync(&report)
        .map_err(|error| error.to_string())?;
    drop(mutation_guard);
    Ok(report)
}

pub async fn bootstrap_and_sync(
    state: &MobileState,
) -> Result<(usize, V2AccountSyncReport), String> {
    enable_local_notebooks(state)?;
    let notebooks = ensure_remote_notebooks(state).await?;
    let report = sync_account(state).await?;
    Ok((notebooks, report))
}

static SYNC_GENERATION: AtomicU64 = AtomicU64::new(0);
static RETRY_ATTEMPTS: AtomicU32 = AtomicU32::new(0);

pub fn schedule_sync(app: AppHandle) {
    schedule_sync_after(app, Duration::from_millis(1_200));
}

fn schedule_sync_after(app: AppHandle, delay: Duration) {
    let generation = SYNC_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if SYNC_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let state = app.state::<MobileState>();
        let cloud = state.cloud_sync.state();
        if cloud.is_ok_and(|value| value.enabled && crate::state::cloud_sync_allowed(&value)) {
            let run_id = uuid::Uuid::new_v4().to_string();
            let started_at = chrono::Utc::now().timestamp_millis();
            crate::commands::emit_sync_status(
                &app, &run_id, "syncing", "transfer", started_at, None, None,
            );
            if let Err(error) = sync_account(state.inner()).await {
                eprintln!("mobile background sync failed: {error}");
                crate::commands::emit_sync_status(
                    &app,
                    &run_id,
                    "error",
                    "retrying",
                    started_at,
                    None,
                    Some(error.clone()),
                );
                schedule_retry_after_failure(app.clone(), &error);
            } else {
                RETRY_ATTEMPTS.store(0, Ordering::SeqCst);
                crate::commands::emit_sync_status(
                    &app, &run_id, "success", "complete", started_at, None, None,
                );
            }
            if let Ok(next) = state.cloud_sync.state() {
                let _ = app.emit("cloud-state-changed", next);
            }
        }
    });
}

/// Retry failures while the app remains active. The shared sync engine may
/// supply a server-aware retry deadline; otherwise use capped exponential
/// backoff so transient connectivity failures eventually converge without a
/// busy loop.
pub fn schedule_retry_after_failure(app: AppHandle, _error: &str) {
    let state = app.state::<MobileState>();
    let cloud = state.cloud_sync.state();
    if !cloud.is_ok_and(|value| value.enabled && crate::state::cloud_sync_allowed(&value)) {
        return;
    }
    let attempt = RETRY_ATTEMPTS.fetch_add(1, Ordering::SeqCst).min(4);
    let fallback_ms = 15_000_i64.saturating_mul(1_i64 << attempt);
    let delay_ms = state
        .cloud_sync
        .v2_retry_delay(chrono::Utc::now().timestamp_millis())
        .ok()
        .flatten()
        .unwrap_or(fallback_ms)
        .clamp(1_000, 5 * 60_000);
    schedule_sync_after(app, Duration::from_millis(delay_ms as u64));
}
