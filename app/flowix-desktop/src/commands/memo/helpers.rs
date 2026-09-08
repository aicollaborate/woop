// ==================== Helpers ====================
//
// Helpers shared by every other section in this module. Marked
// `pub(super)` so the sibling sections (`reads`, `creates`, `versions`,
// `deletes`) can call them directly without leaking them outside `memo`.

use std::path::Path;

use tauri::AppHandle;

use crate::document_mutation::DocumentCommit;
use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use flowix_core::memo_file::{extract_body_content, Memo};
use flowix_core::MemoService;

use crate::app::search_index::try_index_upsert;
use crate::app::state::AppState;
use crate::commands::helpers::synthesize_minimal_memo;
use crate::watcher::runtime::mark_self_write_for;

pub(super) fn read_memo_or_none(state: &AppState, id: &str) -> Option<Memo> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    MemoService::new(&memo_file).memo_metadata(id).ok()
}

pub(super) fn current_notebook_id(state: &AppState) -> String {
    read_lock(&state.memo_file, "memo_file")
        .current_notebook_id_value()
        .unwrap_or_else(|| "nb_default".to_string())
}

pub(super) fn notebook_id_for_memo(state: &AppState, id: &str) -> String {
    let resolved_notebook_id = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        MemoService::new(&memo_file)
            .resolve_memo(id)
            .ok()
            .map(|resolved| resolved.notebook.id)
    };
    resolved_notebook_id.unwrap_or_else(|| current_notebook_id(state))
}

/// Resolve the physical file path for an event payload.
pub(super) fn abs_path_for(state: &AppState, id: &str) -> String {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    MemoService::new(&memo_file)
        .resolve_memo(id)
        .ok()
        .map(|resolved| resolved.path.display().to_string())
        .unwrap_or_default()
}

pub(super) fn emit_updated_memo_event(
    state: &AppState,
    app: &AppHandle,
    id: &str,
    path: String,
    memo: Memo,
    notebook_id: String,
    derived_changed: MemoDerivedChanged,
    source: MemoChangeSource,
    origin_window_label: Option<&str>,
) -> Option<DocumentCommit> {
    try_index_upsert(state, id);
    memo_events::emit_with_commit_from_window(
        app,
        MemoEvent::Updated {
            id: id.to_string(),
            path,
            notebook_id,
            memo,
            derived_changed,
            source,
        },
        origin_window_label,
    )
}

pub(super) fn emit_saved_memo_receipt(
    state: &AppState,
    app: &AppHandle,
    receipt: flowix_core::service::MemoSaveReceipt,
    before: Option<Memo>,
    origin_window_label: &str,
) -> Option<super::WriteDocumentResult> {
    let memo = receipt.edited.memo?;
    let id = receipt.edited.id;
    let path = receipt.edited.path.to_string_lossy().into_owned();
    mark_self_write_for(app, &receipt.edited.path);
    try_index_upsert(state, &id);
    let derived_changed = MemoDerivedChanged::from_memos(before.as_ref(), &memo);
    let commit = receipt.commit.map(|commit| DocumentCommit {
        content_hash: commit.content_hash,
        revision: commit.revision,
        change_id: commit.change_id,
    });
    let commit = memo_events::emit_with_recorded_commit_from_window(
        app,
        MemoEvent::Updated {
            id,
            path: path.clone(),
            notebook_id: receipt.notebook_id,
            memo,
            derived_changed,
            source: MemoChangeSource::UserEdit,
        },
        commit,
        Some(origin_window_label),
    );
    Some(super::WriteDocumentResult {
        path,
        content: receipt.content,
        commit,
    })
}

/// Mark the written file, refresh the search index, and notify the UI.
pub(crate) fn emit_updated_after_write(
    state: &AppState,
    app: &AppHandle,
    id: &str,
    before: Option<Memo>,
    origin_window_label: Option<&str>,
) -> Option<DocumentCommit> {
    let path = abs_path_for(state, id);
    if !path.is_empty() {
        mark_self_write_for(app, Path::new(&path));
    }
    let memo = read_memo_or_none(state, id).unwrap_or_else(|| synthesize_minimal_memo(id));
    let notebook_id = notebook_id_for_memo(state, id);
    let derived_changed = MemoDerivedChanged::from_memos(before.as_ref(), &memo);
    emit_updated_memo_event(
        state,
        app,
        id,
        path,
        memo,
        notebook_id,
        derived_changed,
        MemoChangeSource::UserEdit,
        origin_window_label,
    )
}

/// Lightweight CAS fallback normalization.
///
/// The fast path stays byte-for-byte equality. This is only used after that
/// fails, to tolerate editor serialization noise that does not change the
/// document body meaning: CRLF/LF, frontmatter rewrite, line-end spaces, and
/// empty paragraphs represented as `&nbsp;`/NBSP.
pub(super) fn normalize_markdown_for_cas(content: &str) -> String {
    let lf = content.replace("\r\n", "\n").replace('\r', "\n");
    let body = extract_body_content(&lf);
    let mut out = String::new();
    let mut pending_blank = false;
    let mut wrote_line = false;

    for raw_line in body.lines() {
        let line = raw_line.trim_end();
        let marker = line.trim();
        let is_blank = marker.is_empty() || marker == "&nbsp;" || marker == "\u{00a0}";

        if is_blank {
            pending_blank = true;
            continue;
        }

        if wrote_line {
            out.push('\n');
            if pending_blank {
                out.push('\n');
            }
        }

        out.push_str(line);
        wrote_line = true;
        pending_blank = false;
    }

    out
}

fn code_content_for_cas(content: &str) -> Vec<String> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut fence: Option<(char, usize)> = None;
    let mut lines = Vec::new();
    for line in extract_body_content(&normalized).lines() {
        let trimmed = line.trim_start_matches(' ');
        let indentation = line.len() - trimmed.len();
        if let Some((marker, length)) = fence {
            lines.push(line.to_string());
            let run = trimmed.chars().take_while(|value| *value == marker).count();
            if indentation <= 3 && run >= length && trimmed[run..].trim().is_empty() {
                fence = None;
            }
        } else if indentation <= 3 && (trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
            let marker = trimmed.chars().next().unwrap_or('`');
            let length = trimmed.chars().take_while(|value| *value == marker).count();
            fence = Some((marker, length));
            lines.push(line.to_string());
        } else if indentation >= 4 || line.starts_with('\t') {
            lines.push(line.to_string());
        }
    }
    lines
}

pub(super) fn cas_content_matches(current: &str, expected: &str, incoming: &str) -> bool {
    if current == expected || current == incoming {
        return true;
    }

    let metadata = |content: &str| {
        flowix_core::memo_file::extract_document_metadata(content)
            .ok()
            .map(|mut metadata| {
                if let Some(properties) = metadata.properties.as_object_mut() {
                    properties.remove("key");
                }
                metadata
            })
    };
    matches!((metadata(current), metadata(expected)), (Some(current), Some(expected)) if current == expected)
        && code_content_for_cas(current) == code_content_for_cas(expected)
        && normalize_markdown_for_cas(current) == normalize_markdown_for_cas(expected)
}

pub(super) fn note_title(filename: &str) -> String {
    filename
        .strip_suffix(".md")
        .or_else(|| filename.strip_suffix(".MD"))
        .unwrap_or(filename)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::cas_content_matches;

    #[test]
    fn cas_rejects_frontmatter_only_changes() {
        let current = "---\nkey: note\nstatus: changed\n---\n# Title\n";
        let expected = "---\nkey: note\nstatus: original\n---\n# Title\n";
        assert!(!cas_content_matches(current, expected, "# Title\nnew body"));
    }

    #[test]
    fn cas_preserves_significant_code_whitespace() {
        assert!(!cas_content_matches(
            "```\nvalue  \n```",
            "```\nvalue\n```",
            "updated"
        ));
        assert!(!cas_content_matches(
            "~~~\n\n\nvalue\n~~~",
            "~~~\n\nvalue\n~~~",
            "updated"
        ));
        assert!(!cas_content_matches("    value  ", "    value", "updated"));
    }

    #[test]
    fn cas_does_not_treat_invalid_metadata_as_empty() {
        let current = "---\nstatus: [broken\n---\n# Title\n";
        let expected = "---\nkey: note\n---\n# Title\n";
        assert!(!cas_content_matches(current, expected, "# Title\nnew body"));
    }

    #[test]
    fn cas_accepts_markdown_serialization_noise() {
        let current = "---\nkey: abc123\n---\r\n\r\n# Title\r\n&nbsp;\r\nBody  \r\n";
        let expected = "---\nkey: oldkey\n---\n\n# Title\n\nBody\n";
        let incoming = "---\nkey: abc123\n---\n\n# Title\n&nbsp;\nBody\n";

        assert!(cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_rejects_real_body_change() {
        let current = "---\nkey: abc123\n---\n\n# Title\nChanged\n";
        let expected = "---\nkey: abc123\n---\n\n# Title\nBody\n";
        let incoming = "---\nkey: abc123\n---\n\n# Title\nBody plus local edit\n";

        assert!(!cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_accepts_idempotent_incoming_content() {
        let current = "# Title\n\nBody\n";
        let expected = "# Title\n\nOld body\n";
        let incoming = "# Title\n\nBody\n";

        assert!(cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_accepts_frontmatter_body_leading_blank_drift() {
        let current = "---\nkey: d7ngibb3\n---\n\n# 2026-07-05\n";
        let expected = "---\nkey: d7ngibb3\n---\n# 2026-07-05\n";
        let incoming = "---\nkey: d7ngibb3\n---\n\n\n# 2026-07-05\n\n浣犲ソ";

        assert!(cas_content_matches(current, expected, incoming));
    }
}
