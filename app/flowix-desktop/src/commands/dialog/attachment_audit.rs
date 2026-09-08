use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use walkdir::WalkDir;

use crate::app::state::AppState;
use crate::config::path_is_inside;
use crate::lock_utils::read_lock;

static AUDIT_QUOTA: super::upload_quota::UploadQuota = super::upload_quota::UploadQuota::new(1);
const MAX_ENTRIES: usize = 20_000;
const MAX_ATTACHMENTS: usize = 2000;
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentReference {
    path: String,
    bytes: u64,
    observed_in: Vec<String>,
    safe_to_delete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentScan {
    attachments: Vec<AttachmentReference>,
    scanned_documents: usize,
    incomplete: bool,
    coverage: &'static str,
}

fn scan(target: &Path, roots: &[PathBuf]) -> io::Result<AttachmentScan> {
    let directory = target.join("attachments");
    if !path_is_inside(&directory, target) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Attachment directory escapes notebook",
        ));
    }
    let mut result = AttachmentScan {
        attachments: Vec::new(),
        scanned_documents: 0,
        incomplete: false,
        coverage: "saved_asset_urls_only_no_deletion_authorization",
    };
    let directory = match fs::canonicalize(directory) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(result),
        Err(error) => return Err(error),
    };
    let mut attachments = BTreeMap::new();
    for (index, entry) in WalkDir::new(&directory)
        .follow_links(false)
        .max_depth(64)
        .into_iter()
        .enumerate()
    {
        if index >= MAX_ENTRIES || attachments.len() >= MAX_ATTACHMENTS {
            result.incomplete = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.incomplete = true;
                continue;
            }
        };
        if entry.file_type().is_symlink() || (entry.depth() == 64 && entry.file_type().is_dir()) {
            result.incomplete = true;
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let candidate = || -> io::Result<(PathBuf, AttachmentReference)> {
            if !path_is_inside(entry.path(), &directory) {
                return Err(io::Error::other("Attachment escapes directory"));
            }
            let canonical = fs::canonicalize(entry.path())?;
            let metadata = fs::metadata(&canonical)?;
            Ok((
                canonical,
                AttachmentReference {
                    path: dunce::canonicalize(entry.path())?
                        .to_string_lossy()
                        .into_owned(),
                    bytes: metadata.len(),
                    observed_in: Vec::new(),
                    safe_to_delete: false,
                },
            ))
        };
        match candidate() {
            Ok((path, record)) => {
                attachments.insert(path, record);
            }
            Err(_) => result.incomplete = true,
        }
    }
    let mut entries = 0;
    let mut scanned_bytes = 0;
    'notebooks: for root in roots {
        let walker = WalkDir::new(root)
            .follow_links(false)
            .max_depth(64)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0
                    || !(entry.file_type().is_dir()
                        && matches!(entry.file_name().to_str(), Some("attachments" | ".git")))
            });
        for entry in walker {
            entries += 1;
            if entries > MAX_ENTRIES || scanned_bytes >= MAX_SCAN_BYTES {
                result.incomplete = true;
                break 'notebooks;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    result.incomplete = true;
                    continue;
                }
            };
            if entry.file_type().is_symlink() || (entry.depth() == 64 && entry.file_type().is_dir())
            {
                result.incomplete = true;
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let extension = entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !matches!(
                extension.as_str(),
                "md" | "markdown" | "html" | "htm" | "json"
            ) {
                continue;
            }
            let read = || -> io::Result<Vec<u8>> {
                if !path_is_inside(entry.path(), root) {
                    return Err(io::Error::other("Document escapes notebook"));
                }
                let mut bytes = Vec::new();
                File::open(entry.path())?
                    .take(MAX_DOCUMENT_BYTES.min(MAX_SCAN_BYTES - scanned_bytes) + 1)
                    .read_to_end(&mut bytes)?;
                Ok(bytes)
            };
            let bytes = match read() {
                Ok(bytes) => bytes,
                Err(_) => {
                    result.incomplete = true;
                    continue;
                }
            };
            scanned_bytes += bytes.len() as u64;
            if bytes.len() as u64 > MAX_DOCUMENT_BYTES
                || scanned_bytes > MAX_SCAN_BYTES
                || std::str::from_utf8(&bytes).is_err()
            {
                result.incomplete = true;
                continue;
            }
            result.scanned_documents += 1;
            for path in flowix_sync::referenced_attachment_paths(&directory, &bytes) {
                if let Some(attachment) = attachments.get_mut(&path) {
                    if attachment.observed_in.len() < 20 {
                        attachment
                            .observed_in
                            .push(entry.path().to_string_lossy().into_owned());
                    } else {
                        result.incomplete = true;
                    }
                }
            }
        }
    }
    result.attachments = attachments.into_values().collect();
    Ok(result)
}

#[tauri::command]
pub async fn scan_attachment_references(
    notebook_id: String,
    state: State<'_, AppState>,
) -> Result<AttachmentScan, String> {
    let permit = AUDIT_QUOTA.acquire()?;
    let (target, roots) = {
        let store = read_lock(&state.memo_file, "memo_file");
        let target = super::attachments::notebook_root(&store, Some(&notebook_id))
            .map_err(|error| error.to_string())?;
        let roots = store
            .read_notebook_configs()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|notebook| PathBuf::from(notebook.path))
            .collect::<Vec<_>>();
        (target, roots)
    };
    for root in &roots {
        super::start_security_bookmark_access(&state, root);
    }
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        scan(&target, &roots).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_cross_notebook_links_without_authorizing_deletion() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("first");
        let second = directory.path().join("second");
        fs::create_dir_all(target.join("attachments")).unwrap();
        fs::create_dir_all(&second).unwrap();
        let attachment = target.join("attachments/file.bin");
        fs::write(&attachment, b"data").unwrap();
        fs::write(target.join("attachments/unobserved.bin"), b"other").unwrap();
        let encoded = attachment
            .to_string_lossy()
            .bytes()
            .map(|byte| format!("%{byte:02X}"))
            .collect::<String>();
        fs::write(
            second.join("note.md"),
            format!("[file](asset://localhost/{encoded})"),
        )
        .unwrap();
        let result = scan(&target, &[target.clone(), second]).unwrap();
        assert_eq!(result.attachments.len(), 2);
        assert_eq!(
            result
                .attachments
                .iter()
                .filter(|entry| !entry.observed_in.is_empty())
                .count(),
            1
        );
        assert!(result.attachments.iter().all(|entry| !entry.safe_to_delete));
        assert_eq!(fs::read(&attachment).unwrap(), b"data");
    }

    #[test]
    fn unreadable_text_does_not_become_a_complete_reference_scan() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("attachments")).unwrap();
        fs::write(directory.path().join("bad.md"), [255]).unwrap();
        let result = scan(directory.path(), &[directory.path().to_path_buf()]).unwrap();
        assert!(result.incomplete);
        assert_eq!(result.scanned_documents, 0);
    }
}
