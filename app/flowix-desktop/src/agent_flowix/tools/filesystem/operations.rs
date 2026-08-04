use serde::Deserialize;

use super::constants::{
    DEFAULT_LIST_LIMIT, DEFAULT_READ_LIMIT, DEFAULT_READ_LINE_COUNT, MAX_LIST_LIMIT,
    MAX_READ_LIMIT, MAX_READ_LINE_COUNT,
};
use super::frontmatter::{content_for_write, reread_frontmatter_key_after_write};
use super::path::{
    clamp_limit, ensure_allowed, ensure_min_one, ensure_visible, path_has_hidden_component,
    resolve_path,
};
use crate::agent_flowix::tools::{ToolResult, ToolScope};

fn read_lines(content: &str, start_line: usize, line_count: usize) -> (String, usize, usize, bool) {
    debug_assert!(start_line >= 1);
    let total_lines = content.lines().count();
    let start_index = start_line - 1;
    let lines: Vec<&str> = content.lines().skip(start_index).take(line_count).collect();
    let returned_lines = lines.len();
    let text = lines.join("\n");
    let truncated = start_index + returned_lines < total_lines;
    (text, returned_lines, total_lines, truncated)
}

pub(super) async fn read(arguments: &str, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
        offset: Option<usize>,
        limit: Option<usize>,
        line: Option<usize>,
        line_count: Option<usize>,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    if let Err(result) = ensure_min_one("line", args.line) {
        return result;
    }
    if let Err(result) = ensure_min_one("line_count", args.line_count) {
        return result;
    }

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }
    scope.start_accessing_for_path(&path);
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(e) => return ToolResult::error(format!("Failed to read {}: {}", path.display(), e)),
    };

    if let Some(line) = args.line {
        let line_count = clamp_limit(
            args.line_count,
            DEFAULT_READ_LINE_COUNT,
            MAX_READ_LINE_COUNT,
        );
        let (text, returned_lines, total_lines, truncated) = read_lines(&content, line, line_count);
        return ToolResult::success(serde_json::json!({
            "path": path.display().to_string(),
            "content": text,
            "line": line,
            "line_count": line_count,
            "returned_lines": returned_lines,
            "total_lines": total_lines,
            "truncated": truncated,
        }));
    }

    let offset = args.offset.unwrap_or(0);
    let limit = clamp_limit(args.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    let total_chars = content.chars().count();
    let text: String = content.chars().skip(offset).take(limit).collect();

    ToolResult::success(serde_json::json!({
        "path": path.display().to_string(),
        "content": text,
        "offset": offset,
        "returned_chars": text.chars().count(),
        "total_chars": total_chars,
        "truncated": offset + limit < total_chars,
    }))
}

#[cfg(test)]
pub(super) async fn write(arguments: &str, scope: &ToolScope) -> ToolResult {
    write_with_memo(arguments, scope, None).await
}

pub(super) async fn write_with_memo(
    arguments: &str,
    scope: &ToolScope,
    memo_file: Option<&std::sync::RwLock<flowix_core::memo_file::MemoFile>>,
) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
        content: String,
        append: Option<bool>,
        create_dirs: Option<bool>,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }
    scope.start_accessing_for_path(&path);
    if args.create_dirs.unwrap_or(true) {
        if let Some(parent) = path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return ToolResult::error(format!(
                    "Failed to create parent directory {}: {}",
                    parent.display(),
                    e
                ));
            }
        }
    }

    let append = args.append.unwrap_or(false);
    let content_to_write = content_for_write(&path, &args.content, append).await;

    if !append {
        if let Some(memo_file) = memo_file {
            match super::save_registered_memo(&path, &content_to_write, memo_file) {
                Ok(Some(saved)) => {
                    return ToolResult::success(serde_json::json!({
                        "path": saved.path.display().to_string(),
                        "key": saved.key,
                        "bytes_written": content_to_write.len(),
                        "append": false,
                    }));
                }
                Ok(None) => {}
                Err(error) => return ToolResult::error(error),
            }
        }
    }

    let result: std::io::Result<()> = if append {
        use tokio::io::AsyncWriteExt;
        let mut file = match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            Ok(f) => f,
            Err(e) => {
                return ToolResult::error(format!(
                    "Failed to open {} for append: {}",
                    path.display(),
                    e
                ))
            }
        };
        file.write_all(content_to_write.as_bytes())
            .await
            .map(|_| ())
    } else {
        tokio::fs::write(&path, content_to_write.as_bytes()).await
    };

    match result {
        Ok(()) => {
            let key = reread_frontmatter_key_after_write(&path).await;
            ToolResult::success(serde_json::json!({
                "path": path.display().to_string(),
                "key": key.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                "bytes_written": content_to_write.len(),
                "append": append,
            }))
        }
        Err(e) => ToolResult::error(format!("Failed to write {}: {}", path.display(), e)),
    }
}

pub(super) async fn delete(
    arguments: &str,
    scope: &ToolScope,
    memo_file: &std::sync::RwLock<flowix_core::memo_file::MemoFile>,
    app: Option<&tauri::AppHandle>,
) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }
    scope.start_accessing_for_path(&path);

    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(e) => return ToolResult::error(format!("Failed to inspect {}: {}", path.display(), e)),
    };
    if !metadata.is_file() {
        return ToolResult::error(format!(
            "delete only supports files, not directories: {}",
            path.display()
        ));
    }

    // 已索引的 .md memo → 走领域删除 (注销 memo index + 删文件) 并直接 emit
    // `Deleted`, 绕开 watcher 对 Remove 的被动反查 —— 那条路径在 filename / 绝对
    // 路径校验不一致时会静默丢事件 (见 watcher/processor.rs `unregister_and_emit`
    // 与 reconcile.rs `unregister_memo_by_path_for_notebook_id`)。非 memo 或反查
    // 不到 → fallback 裸 fs::remove_file, 保留通用文件删除语义 (附件 / 孤立 .md)。
    if let Some(result) = delete_indexed_memo(&path, memo_file, app) {
        return result;
    }

    match tokio::fs::remove_file(&path).await {
        Ok(()) => ToolResult::success(serde_json::json!({
            "path": path.display().to_string(),
            "deleted": true,
        })),
        Err(e) => ToolResult::error(format!("Failed to delete {}: {}", path.display(), e)),
    }
}

/// 若 `path` 指向一个已索引的 memo, 走领域服务删除并 emit `MemoEvent::Deleted`;
/// 否则返回 `None`, 由调用方 fallback 到裸 `fs::remove_file`。
///
/// 判定对齐 `save_registered_memo`: 读 frontmatter `key` → `resolve_memo` →
/// canonicalize 后路径必须与 `resolved.path` 一致, 才认定是受管理的 memo。
///
/// 不调用 `mark_self_write`: watcher 的 `Remove` 分支不查 self-write 表, 且
/// `MemoService::delete_memo` 先删文件后注销 index —— watcher 收到 Remove 时
/// filename 反查要么已空 (未命中 → worker → `unregister_and_emit` no-op), 要么
/// 进 tombstone、450ms 后再查时 index 已空 (no-op), 天然不会重复 emit。
fn delete_indexed_memo(
    path: &std::path::Path,
    memo_file: &std::sync::RwLock<flowix_core::memo_file::MemoFile>,
    app: Option<&tauri::AppHandle>,
) -> Option<ToolResult> {
    use tauri::Manager;

    let is_md = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
    if !is_md {
        return None;
    }
    let app = app?;

    let content = std::fs::read_to_string(path).ok()?;
    let key = flowix_core::memo_file::extract_frontmatter_key(&content)?;

    // 解析 + 路径校验 (与 save_registered_memo 同一口径)
    let (id, notebook_id, abs_path, before) = {
        let guard = memo_file.read().ok()?;
        let mut service = flowix_core::MemoService::new(&guard);
        let resolved = service.resolve_memo(&key).ok()?;
        let requested = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let resolved_path =
            dunce::canonicalize(&resolved.path).unwrap_or_else(|_| resolved.path.clone());
        if requested != resolved_path {
            return None;
        }
        let before = service.memo_metadata(&resolved.id).ok();
        (
            resolved.id,
            resolved.notebook.id,
            resolved.path.display().to_string(),
            before,
        )
    };

    // 领域删除: 注销 memo index + 删文件 (delete_memo_result_global)
    let file_removed = {
        let guard = memo_file.read().ok()?;
        let mut service = flowix_core::MemoService::new(&guard);
        match service.delete_memo(&id) {
            Ok(deleted) => deleted.file_removed,
            Err(error) => {
                return Some(ToolResult::error(format!(
                    "Failed to delete memo {}: {}",
                    path.display(),
                    error
                )));
            }
        }
    };
    if !file_removed {
        return None;
    }

    // search index 清理 (对齐 IPC delete_memo)
    if let Some(state) = app.try_state::<crate::app::state::AppState>() {
        crate::app::search_index::try_index_remove(state.inner(), &id);
    }

    let derived_changed = before
        .as_ref()
        .map(crate::memo_events::MemoDerivedChanged::from_deleted)
        .unwrap_or_default();
    crate::memo_events::emit(
        app,
        crate::memo_events::MemoEvent::Deleted {
            id,
            path: abs_path,
            notebook_id,
            derived_changed,
            source: crate::memo_events::MemoChangeSource::ExternalTool,
        },
    );

    Some(ToolResult::success(serde_json::json!({
        "path": path.display().to_string(),
        "deleted": true,
    })))
}

pub(super) async fn ls(arguments: &str, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
        limit: Option<usize>,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }
    scope.start_accessing_for_path(&path);
    let limit = clamp_limit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    let mut entries = match tokio::fs::read_dir(&path).await {
        Ok(entries) => entries,
        Err(e) => return ToolResult::error(format!("Failed to list {}: {}", path.display(), e)),
    };

    let mut result = Vec::new();
    // `take(limit)` �?async iter 上不能直接调 ── tokio::fs::ReadDir �?    // `next_entry` 一欤��回一�? 手动控制上限�?
    let mut count = 0usize;
    loop {
        if count >= limit {
            break;
        }
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => continue,
        };
        if path_has_hidden_component(&entry.path()) {
            continue;
        }
        let meta = entry.metadata().await.ok();
        result.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().display().to_string(),
            "is_dir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            "is_file": meta.as_ref().map(|m| m.is_file()).unwrap_or(false),
            "size": meta.as_ref().map(|m| m.len()),
        }));
        count += 1;
    }

    ToolResult::success(serde_json::json!({
        "path": path.display().to_string(),
        "entries": result,
        "limit": limit,
    }))
}

// ============== glob / grep: spawn_blocking + 涓婇檺 ==============
//
// glob / grep �?`WalkDir` 这类 crate-level 同�? API, 即便�?// `tokio::fs` 也不解决"遍历�?��树不�?worker 调度"的问题�?整�?塞进
// `tokio::task::spawn_blocking`, �?worker 真�?能跑�?�� task; 同时�?// MAX_GLOB_FILES / MAX_GREP_FILES / MAX_GREP_TOTAL_BYTES /
// MAX_GREP_FILE_BYTES / MAX_GREP_WALLCLOCK 多重�?���? 触发上限�?// truncated 标�?, LLM �??�?�� (缩窄 path)�?
