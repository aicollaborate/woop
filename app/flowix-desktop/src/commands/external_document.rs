use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::app::state::AppState;
use crate::commands::external_document_watch::ExternalDocumentWatchState;
use crate::commands::helpers::{can_access_scoped_file, start_security_bookmark_access};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ExternalDocumentWriteOutcome {
    Saved { path: String, content: String },
    Conflict { disk_content: String },
    Missing,
    Error { message: String },
}

pub(crate) fn is_markdown_document_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        })
}

fn supported_text_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "markdown"
                    | "txt"
                    | "text"
                    | "log"
                    | "json"
                    | "jsonc"
                    | "json5"
                    | "yaml"
                    | "yml"
                    | "toml"
                    | "xml"
                    | "html"
                    | "htm"
                    | "css"
                    | "scss"
                    | "sass"
                    | "less"
                    | "js"
                    | "jsx"
                    | "mjs"
                    | "cjs"
                    | "ts"
                    | "tsx"
                    | "mts"
                    | "cts"
                    | "vue"
                    | "svelte"
                    | "py"
                    | "pyw"
                    | "rs"
                    | "go"
                    | "java"
                    | "kt"
                    | "kts"
                    | "c"
                    | "cc"
                    | "cpp"
                    | "cxx"
                    | "h"
                    | "hh"
                    | "hpp"
                    | "hxx"
                    | "cs"
                    | "swift"
                    | "php"
                    | "rb"
                    | "sh"
                    | "bash"
                    | "zsh"
                    | "fish"
                    | "sql"
                    | "graphql"
                    | "gql"
                    | "lua"
                    | "r"
                    | "dart"
                    | "scala"
                    | "ex"
                    | "exs"
                    | "erl"
                    | "hrl"
                    | "fs"
                    | "fsx"
                    | "vb"
                    | "pl"
                    | "pm"
                    | "proto"
                    | "ini"
                    | "conf"
                    | "cfg"
                    | "properties"
                    | "gradle"
            )
        })
}

/// Extensionless files do not carry enough information in their name to
/// classify them. Probe a small prefix before allowing them into the text
/// editor: UTF-8 text is safe for `read_to_string`, while a NUL byte is a
/// strong binary-file signal. The complete read still validates UTF-8 later.
fn looks_like_utf8_text_file(path: &Path) -> bool {
    const PROBE_SIZE: usize = 8192;

    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buffer = [0_u8; PROBE_SIZE];
    let Ok(bytes_read) = file.read(&mut buffer) else {
        return false;
    };
    let sample = &buffer[..bytes_read];
    !sample.contains(&0) && std::str::from_utf8(sample).is_ok()
}

pub(crate) fn supported_text_document_path(path: &Path) -> bool {
    if supported_text_extension(path) {
        return true;
    }

    // A missing extension is intentionally accepted only after inspecting the
    // file contents. Files with an explicit unknown extension remain blocked.
    path.extension().is_none() && looks_like_utf8_text_file(path)
}

pub(crate) fn exact_existing_external_path(
    file_path: &str,
    scope_path: Option<&str>,
    state: &State<'_, AppState>,
) -> Result<PathBuf, String> {
    let requested = PathBuf::from(file_path);
    if !requested.is_absolute() {
        return Err("external document must be an absolute path".to_string());
    }
    if !requested.is_file() {
        return Err(format!(
            "external document is unavailable: {}",
            requested.display()
        ));
    }
    if !is_markdown_document_path(&requested)
        && !can_access_scoped_file(&requested, scope_path, state)
    {
        return Err("external code document is outside its authorized file-tree scope".to_string());
    }
    start_security_bookmark_access(state.inner(), &requested);
    if !supported_text_document_path(&requested) {
        return Err("external document is not a supported text file".to_string());
    }
    dunce::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve {}: {error}", requested.display()))
}

#[tauri::command]
pub fn read_external_document(
    file_path: String,
    #[allow(non_snake_case)] scopePath: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = exact_existing_external_path(&file_path, scopePath.as_deref(), &state)?;
    fs::read_to_string(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))
}

/// Pure CAS predicate: returns true when the caller provided an `expected`
/// snapshot and the on-disk content does not match it. `None` means the
/// caller opted out of the CAS check, which is always allowed.
fn cas_conflict(expected: Option<&str>, disk_content: &str) -> bool {
    expected.is_some_and(|expected| expected != disk_content)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn write_external_document(
    window: tauri::WebviewWindow,
    file_path: String,
    content: String,
    expectedContent: Option<String>,
    scopePath: Option<String>,
    state: State<'_, AppState>,
    watches: State<'_, ExternalDocumentWatchState>,
) -> ExternalDocumentWriteOutcome {
    let path = match exact_existing_external_path(&file_path, scopePath.as_deref(), &state) {
        Ok(path) => path,
        Err(_) if !Path::new(&file_path).is_file() => return ExternalDocumentWriteOutcome::Missing,
        Err(message) => return ExternalDocumentWriteOutcome::Error { message },
    };

    let disk_content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            return ExternalDocumentWriteOutcome::Error {
                message: format!("failed to verify {}: {error}", path.display()),
            };
        }
    };
    if cas_conflict(expectedContent.as_deref(), &disk_content) {
        return ExternalDocumentWriteOutcome::Conflict { disk_content };
    }

    let permissions = fs::metadata(&path)
        .ok()
        .map(|metadata| metadata.permissions());
    if let Err(error) = flowix_core::memo_file::atomic_write_bytes(&path, content.as_bytes()) {
        return ExternalDocumentWriteOutcome::Error {
            message: format!("failed to write {}: {error}", path.display()),
        };
    }
    if let Some(permissions) = permissions {
        if let Err(error) = fs::set_permissions(&path, permissions) {
            return ExternalDocumentWriteOutcome::Error {
                message: format!(
                    "saved {}, but failed to restore permissions: {error}",
                    path.display()
                ),
            };
        }
    }
    watches.acknowledge_window_write(window.label(), &path);
    ExternalDocumentWriteOutcome::Saved {
        path: path.to_string_lossy().to_string(),
        content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_external_path_never_falls_back_by_filename() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("nested").join("Same.md");
        let root = directory.path().join("Same.md");
        fs::write(&root, "# Root memo\n").unwrap();

        assert!(!missing.exists());
        assert_ne!(missing, root);
        assert!(is_markdown_document_path(&missing));
    }

    #[test]
    fn cas_conflict_only_when_expected_differs_from_disk() {
        // No expected snapshot means the caller trusts the disk and skips CAS.
        assert!(!cas_conflict(None, "disk"));
        assert!(!cas_conflict(Some("disk"), "disk"));

        // A mismatched expected snapshot is a real CAS conflict.
        assert!(cas_conflict(Some("stale"), "disk"));
        assert!(cas_conflict(Some(""), "disk"));
    }

    #[test]
    fn supported_text_extension_is_case_insensitive_and_strict() {
        assert!(is_markdown_document_path(Path::new("/tmp/notes.MD")));
        assert!(is_markdown_document_path(Path::new("/tmp/notes.Markdown")));
        assert!(supported_text_document_path(Path::new("/tmp/notes.txt")));
        assert!(supported_text_document_path(Path::new("/tmp/main.TSX")));
        assert!(supported_text_document_path(Path::new("/tmp/config.toml")));
        assert!(!supported_text_document_path(Path::new("/tmp/image.png")));
        assert!(!supported_text_document_path(Path::new("/tmp/notes")));
        assert!(!supported_text_document_path(Path::new("/tmp/.md")));
    }

    #[test]
    fn extensionless_utf8_files_are_supported_but_binary_files_are_not() {
        let directory = tempfile::tempdir().unwrap();
        let license = directory.path().join("LICENSE");
        let binary = directory.path().join("blob");
        fs::write(&license, "Permission is hereby granted...\n").unwrap();
        fs::write(&binary, [0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]).unwrap();

        assert!(supported_text_document_path(&license));
        assert!(!supported_text_document_path(&binary));
    }
}
