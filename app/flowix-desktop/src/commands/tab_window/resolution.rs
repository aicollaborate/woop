//! Resolve a path/memo into a WindowTab.
use super::types::{TabTarget, WindowTab};
use crate::app::state::AppState;
use crate::lock_utils::read_lock;

pub(super) fn refresh_tab(tab: &WindowTab, state: &AppState) -> Result<WindowTab, String> {
    match &tab.target {
        TabTarget::Memo { memo_id, .. } => resolve_memo_tab(memo_id, state),
        TabTarget::ExternalMarkdown { file_path } => resolve_external_markdown_tab(file_path),
        TabTarget::Web { .. } => Ok(tab.clone()),
    }
}

pub(super) fn resolve_external_markdown_tab(file_path: &str) -> Result<WindowTab, String> {
    let requested = std::path::PathBuf::from(file_path);
    let is_markdown = requested
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        });
    if !is_markdown || !requested.is_file() {
        return Err(format!(
            "external Markdown is unavailable: {}",
            requested.display()
        ));
    }
    let canonical = dunce::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve external Markdown: {error}"))?;
    let title = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "external Markdown filename is unavailable".to_string())?
        .to_string();
    let canonical = canonical.to_string_lossy().to_string();
    Ok(WindowTab {
        id: format!("external:{canonical}"),
        title,
        icon: None,
        target: TabTarget::ExternalMarkdown {
            file_path: canonical,
        },
    })
}

pub(super) fn resolve_markdown_path_tab(
    file_path: &str,
    state: &AppState,
) -> Result<WindowTab, String> {
    let memo_tab = if is_direct_registered_notebook_child(file_path, state) {
        crate::open_target::parse_open_target(file_path)
            .ok()
            .and_then(|target| {
                crate::open_target::resolve_open_target(target, state.memo_file.as_ref()).ok()
            })
            .map(|resolved| resolve_memo_tab(&resolved.memo_id, state))
            .transpose()?
    } else {
        None
    };
    match memo_tab {
        Some(tab) => Ok(tab),
        None => resolve_external_markdown_tab(file_path),
    }
}

pub(super) fn is_direct_registered_notebook_child(file_path: &str, state: &AppState) -> bool {
    let Ok(file_path) = dunce::canonicalize(file_path) else {
        return false;
    };
    let Some(parent) = file_path.parent() else {
        return false;
    };
    let notebook_roots = read_lock(&state.memo_file, "memo_file").registered_notebook_paths();
    notebook_roots
        .into_iter()
        .any(|root| dunce::canonicalize(root).is_ok_and(|canonical_root| canonical_root == parent))
}

pub(super) fn resolve_memo_tab(memo_id: &str, state: &AppState) -> Result<WindowTab, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let location = memo_file
        .resolve_memo_location(memo_id)
        .map_err(|e| format!("resolve memo location failed: {e}"))?
        .ok_or_else(|| format!("memo not found: {memo_id}"))?;
    let file_path = std::path::PathBuf::from(&location.notebook.path)
        .join(&location.memo.filename)
        .to_string_lossy()
        .to_string();

    Ok(WindowTab {
        id: format!("memo:{memo_id}"),
        title: location.memo.filename,
        icon: location.memo.icon,
        target: TabTarget::Memo {
            memo_id: memo_id.to_string(),
            notebook_id: location.notebook.id,
            notebook_path: location.notebook.path,
            file_path,
        },
    })
}

pub(super) fn tab_window_title(tab: &WindowTab) -> &str {
    let title = tab.title.as_str();
    let Some((stem, extension)) = title.rsplit_once('.') else {
        return title;
    };
    if extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown") {
        stem
    } else {
        title
    }
}
