use super::*;

pub(super) fn codex_session_files() -> Result<Vec<PathBuf>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    Ok(WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect())
}

pub(super) fn find_codex_session_file(session_id: &str) -> Result<Option<PathBuf>, String> {
    for path in codex_session_files()? {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.contains(session_id))
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    for path in codex_session_files()? {
        if read_codex_session_meta(&path)
            .map(|meta| meta.id == session_id)
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

pub(super) fn session_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let parts = stem.rsplit('-').take(5).collect::<Vec<_>>();
    if parts.len() == 5 {
        Some(parts.into_iter().rev().collect::<Vec<_>>().join("-"))
    } else {
        None
    }
}

/// �?Codex CLI �?session jsonl 里�?出原�?cwd ── Codex rollout 文件
/// �?��行通常�?`session_meta` 事件, 内嵌 `payload.cwd` 字�?.
///
/// 用�? 后�? `codex_cli.rs` �?cwd 兜底�?── IPC 入参拿不�?cwd �?
/// �?session 文件�?���?cwd 作为真源�?�?claude �??同形 (�?/// `claude_history::claude_session_cwd` 注释).
pub fn codex_session_cwd(session_id: &str) -> Result<Option<PathBuf>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };
    codex_session_cwd_in(&home, session_id)
}

pub(crate) fn codex_session_cwd_in(
    home: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let Some(path) = codex_session_files_in(home)
        .into_iter()
        .flatten()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.contains(session_id))
                .unwrap_or(false)
                || read_codex_session_meta(path)
                    .map(|meta| meta.id == session_id)
                    .unwrap_or(false)
        })
    else {
        return Ok(None);
    };
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(cwd) = value
            .get("payload")
            .and_then(|p| p.get("cwd"))
            .and_then(Value::as_str)
        {
            let trimmed = cwd.trim();
            if !trimmed.is_empty() {
                return Ok(Some(PathBuf::from(trimmed)));
            }
        }
    }
    Ok(None)
}

pub(super) fn codex_session_files_in(home: &Path) -> Result<Vec<PathBuf>, String> {
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    Ok(WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect())
}

pub(super) fn truncate_title(text: &str) -> String {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= 40 {
        trimmed
    } else {
        format!("{}...", trimmed.chars().take(40).collect::<String>())
    }
}

pub(super) fn truncate_history_tool_output(text: &str) -> String {
    if text.chars().count() <= MAX_HISTORY_TOOL_OUTPUT_CHARS {
        text.to_string()
    } else {
        format!(
            "{}\n...[truncated]",
            text.chars()
                .take(MAX_HISTORY_TOOL_OUTPUT_CHARS)
                .collect::<String>()
        )
    }
}

#[allow(dead_code)]
pub(super) fn normalize_epoch_millis(ts: i64) -> i64 {
    if ts < 10_000_000_000 {
        ts * 1000
    } else {
        ts
    }
}

pub(super) fn parse_timestamp_millis(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp_millis())
}
