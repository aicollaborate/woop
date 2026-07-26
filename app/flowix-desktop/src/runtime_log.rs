use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::{json, Value};

use crate::{APP_DATA_DIR_NAME, USER_CONFIG_DIR_NAME};

pub const PRODUCT_NAME: &str = "Flowix";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

static LOG_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub fn user_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(USER_CONFIG_DIR_NAME)
}

pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(APP_DATA_DIR_NAME)
}

pub fn log_dir() -> PathBuf {
    user_config_dir().join("logs")
}

pub fn ensure_log_dir() -> std::io::Result<PathBuf> {
    let dir = log_dir();
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn record_event(level: &str, event: &str, message: impl AsRef<str>) {
    let log_dir = match ensure_log_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let file_name = if level.eq_ignore_ascii_case("error") {
        "error.log"
    } else {
        "app.log"
    };
    let path = log_dir.join(file_name);
    let line = json!({
        "time": chrono::Utc::now().to_rfc3339(),
        "level": level,
        "event": event,
        "message": message.as_ref(),
        "product": PRODUCT_NAME,
        "version": APP_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
    });

    append_json_line(path, &line);
}

/// 记录 Agent (LLM chat / tool 调用) 的一次结构化事件�?///
/// �?`record_event` 的区�?
/// - �?`~/.flowix/logs/agent.log`, 与通用 `app.log` / `error.log` 物理隔�?,
///   便于「只�?Agent 错�?」时直接 `cat agent.log | grep '"level":"error"'`�?/// - JSON 形状多带 `thread_id` / `tool` / `kind` 字�? ── agent 错�?天然
///   �?thread 绑定, 不带 thread_id 在并行情�?��无法定位�?���??话出�?///   �??。`kind` 给前�?/ 排障脚本一�?��定的判别维度 (例�?
///   `kind=llm_stream` / `kind=tool_error` / `kind=stuck` / `kind=max_cycles` /
///   `kind=token_budget` / `kind=recovery_retry`)銆?///
/// 与「LLM 错�?流回 Agent 处理」的关系: 工具调用失败 / LLM 流断 等事�?/// 都会�?emit `AgentChunk::ToolResult` / `Error` 块把信息交给 LLM 让它
/// �?�� (重试 / 换工�?/ 改路�?/ 收口), 这里�?`record_agent_event` �?/// **镜像**到�?�? 供后�?���? 不替�?LLM 决策�?���?///
/// `level` �?`event` 沿用 `record_event` 的�?�?── `level` 仅控制日�?/// 行的�?��分级, 不影响文件路�?(agent 全部�?`agent.log`)�?///
/// IO 失败 (磁盘�?/ 权限不足) 一律静默吞�? 避免日志�?���?chat
/// 主流程搞�?── �?`record_event` 保持一致的"尽力而为"�?���?
pub fn record_agent_event(
    level: &str,
    kind: &str,
    event: &str,
    message: impl AsRef<str>,
    thread_id: Option<&str>,
    tool: Option<&str>,
    extra: Option<Value>,
) {
    let log_dir = match ensure_log_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let path = log_dir.join("agent.log");

    let mut line = json!({
        "time": chrono::Utc::now().to_rfc3339(),
        "level": level,
        "kind": kind,
        "event": event,
        "message": message.as_ref(),
        "product": PRODUCT_NAME,
        "version": APP_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
    });
    if let Some(tid) = thread_id {
        line["thread_id"] = Value::String(tid.to_string());
    }
    if let Some(tool) = tool {
        line["tool"] = Value::String(tool.to_string());
    }
    if let Some(extra) = extra {
        if let Value::Object(map) = extra {
            if let Value::Object(ref mut base) = line {
                for (k, v) in map {
                    base.insert(k, v);
                }
            }
        }
    }

    append_json_line(path, &line);
}

/// 测试专用: 把结构化事件写到指定�?��, 不污染用�?`~/.flowix/logs/agent.log`�?/// 复用 `record_agent_event` 同样�?JSON 行形�?── 单元测试�?��言字�?集�?
#[cfg(test)]
pub fn record_agent_event_to(dir: &PathBuf, level: &str, kind: &str, event: &str, message: &str) {
    let path = dir.join("agent.log");
    let line = json!({
        "time": chrono::Utc::now().to_rfc3339(),
        "level": level,
        "kind": kind,
        "event": event,
        "message": message,
        "product": PRODUCT_NAME,
        "version": APP_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
    });
    append_json_line(path, &line);
}

fn append_json_line(path: PathBuf, line: &Value) {
    let Ok(_guard) = LOG_WRITE_LOCK.lock() else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

// ---------------------------------------------------------------------------
// dev-only external agent stdout dump (`~/.flowix/debug/`)
// ---------------------------------------------------------------------------

/// dev �??才启用的 external agent stdout 原�?�?dump �?��: `~/.flowix/debug/`�?/// �?`log_dir()` (`~/.flowix/logs/`) 物理隔�? ── debug 装的�?��进程 stdout
/// 原文全量, 体量大且�?���?��户笔记内�? �?dev 构建写入, release 不触碰�?
pub fn debug_dir() -> PathBuf {
    user_config_dir().join("debug")
}

/// 专属�?debug dump 的写入锁, �?`LOG_WRITE_LOCK` 隔�? ── debug 行数远�?�?
/// agent.log (单�? claude 运�?�?��千�?, �?��锁避免拖慢常规日志�?
static DEBUG_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// �?dev 构建: �?external agent (claude / codex) 子进�?stdout 的一行原�?/// JSONL 追加 dump �?`~/.flowix/debug/<agent>-<run_id>.jsonl`�?///
/// �?`record_agent_event` (�?`agent.log` 结构化事件摘�? 的区�? 这里写的�?/// 子进�?stdout 原文全量 (�?`thinking_tokens` 增量 / `tool_use` / `tool_result`
/// 原�?�?, 供排障时 1:1 还原 vendor CLI 真实回包�?///
/// **�?dev**: `cfg!(debug_assertions)` 门控, release 构建立即返回 ── 不建�?���?/// 不开文件, 生产�??绝不把用户笔记内�?/ agent 流数�?��盘。IO 失败静默吞掉,
/// 不影响流处理主路�?(�?`record_agent_event` 一致的"尽力而为"�?��)�?///
/// `thread_id` 当前不进文件�?(`run_id` 已唯一标识�??运�?), 保留参数位是�?/// 后续按�?话归�?/ 注入 dump header 预留, 也�?调用点�?义自解释�?
pub fn dump_debug_stdout_line(agent_type: &str, _thread_id: &str, run_id: &str, line: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    dump_debug_stdout_line_to(&debug_dir(), agent_type, run_id, line);
}

/// `dump_debug_stdout_line` 的核心写入逻辑, 接受任意�?�� ── 供单测在不污�?/// 用户 `~/.flowix/debug/` 的前提下�?��行为。不�?dev 门控 (test 都是 debug
/// profile, 门控恒真)�?
fn dump_debug_stdout_line_to(dir: &PathBuf, agent_type: &str, run_id: &str, line: &str) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let file_name = format!(
        "{}-{}.jsonl",
        sanitize_debug_id(agent_type),
        sanitize_debug_id(run_id)
    );
    let path = dir.join(file_name);
    let Ok(_guard) = DEBUG_WRITE_LOCK.lock() else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// 把任意字符串收敛成安全的文件名片�? �?���?`[A-Za-z0-9._-]`, 其余替换�?`_`�?/// `agent_type` / `run_id` 通常已是安全字�?, 这里�?��御性兜�? 避免�?��穿越 / 非法文件名�?
fn sanitize_debug_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_agent_event_writes_one_json_line_per_call() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_path_buf();
        record_agent_event_to(&dir, "error", "llm_stream", "llm.stream_failed", "boom");
        record_agent_event_to(&dir, "warn", "stuck", "agent.stuck", "loop");

        let body = std::fs::read_to_string(dir.join("agent.log")).expect("read agent.log");
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2, "each call must append exactly one line");

        // �?���? 必含字�? + level=error + kind=llm_stream
        let v0: serde_json::Value = serde_json::from_str(lines[0]).expect("line 0 is JSON");
        assert_eq!(v0["level"], "error");
        assert_eq!(v0["kind"], "llm_stream");
        assert_eq!(v0["event"], "llm.stream_failed");
        assert_eq!(v0["message"], "boom");
        assert_eq!(v0["product"], PRODUCT_NAME);
        assert!(v0["time"].is_string(), "time must be RFC3339 string");
        assert!(v0["pid"].is_u64(), "pid must be a number");

        // 绗簩琛? level=warn + kind=stuck
        let v1: serde_json::Value = serde_json::from_str(lines[1]).expect("line 1 is JSON");
        assert_eq!(v1["level"], "warn");
        assert_eq!(v1["kind"], "stuck");
    }

    #[test]
    fn record_agent_event_does_not_touch_app_log_or_error_log() {
        // agent 事件�?�� agent.log ── 不污�?app.log / error.log�?        // 用空 tempdir, 调用后只能看�?agent.log, 不应该有其它文件�?
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_path_buf();
        record_agent_event_to(&dir, "error", "tool_error", "tool.execution_failed", "x");

        let mut entries: Vec<String> = std::fs::read_dir(&dir)
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        entries.sort();
        assert_eq!(entries, vec!["agent.log"], "only agent.log should exist");
    }

    #[test]
    fn dump_debug_stdout_line_to_appends_raw_lines() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_path_buf();
        dump_debug_stdout_line_to(
            &dir,
            "claude",
            "run-abc",
            "{\"type\":\"system\",\"subtype\":\"init\"}",
        );
        dump_debug_stdout_line_to(&dir, "claude", "run-abc", "{\"type\":\"assistant\"}");

        // 鍚屼竴 run 澶氳 -> 鍚屼竴鏂囦欢杩藉姞, 姣忔涓€琛屻€?
        let body = std::fs::read_to_string(dir.join("claude-run-abc.jsonl")).expect("read dump");
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2, "each call appends exactly one line");
        assert!(lines[0].contains("\"subtype\":\"init\""));
        assert!(lines[1].contains("\"assistant\""));
    }

    #[test]
    fn dump_debug_stdout_line_to_partitions_per_run() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_path_buf();
        dump_debug_stdout_line_to(&dir, "claude", "run-1", "a");
        dump_debug_stdout_line_to(&dir, "claude", "run-2", "b");

        // 不同 run_id -> 不同文件, 互不覆盖�?
        assert_eq!(
            std::fs::read_to_string(dir.join("claude-run-1.jsonl")).unwrap(),
            "a\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("claude-run-2.jsonl")).unwrap(),
            "b\n"
        );
    }

    #[test]
    fn sanitize_debug_id_keeps_safe_chars_only() {
        assert_eq!(sanitize_debug_id("claude"), "claude");
        assert_eq!(sanitize_debug_id("run-1.2"), "run-1.2");
        // 空格 / 斜杠等非法文件名字�? -> '_', 阻断�?��穿越�?
        assert_eq!(sanitize_debug_id("a b/c"), "a_b_c");
        assert_eq!(sanitize_debug_id("../etc"), ".._etc");
    }
}
