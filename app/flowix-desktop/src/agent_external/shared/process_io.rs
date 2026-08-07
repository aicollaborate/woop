use super::*;

/// Hard cap (in bytes) on a single line of stdout read from an external CLI.
/// Without this, a single tool output that happens to land on a child's
/// stdout without a trailing newline — e.g. a giant heredoc — would force the
/// reader to accumulate the whole payload in memory before parsing. 512 KiB
/// covers every realistic tool result; anything larger goes through the
/// truncated path and is recorded in `runtime_log`.
pub const MAX_STDOUT_LINE_BYTES: usize = 512 * 1024;

/// Read a single line from a stdout-style async reader with a hard byte cap.
/// Returns `Ok(None)` at clean EOF, `Ok(Some((line, truncated)))` otherwise.
/// `truncated == true` means the source line exceeded the cap and the
/// returned string is the cap-sized prefix; the reader's internal cursor has
/// been advanced past the newline (if any) so subsequent calls resume cleanly.
pub async fn read_capped_line<R>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<(String, bool)>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut out = Vec::new();
    let mut truncated = false;
    loop {
        let available = reader.fill_buf().await.map_err(|e| e.to_string())?;
        if available.is_empty() {
            if out.is_empty() && !truncated {
                return Ok(None);
            }
            return Ok(Some((String::from_utf8_lossy(&out).to_string(), truncated)));
        }

        let newline_pos = available.iter().position(|byte| *byte == b'\n');
        let take_len = newline_pos.map(|pos| pos + 1).unwrap_or(available.len());
        if out.len() < max_bytes {
            let remaining = max_bytes - out.len();
            out.extend_from_slice(&available[..take_len.min(remaining)]);
            if take_len > remaining {
                truncated = true;
            }
        } else {
            truncated = true;
        }

        reader.consume(take_len);
        if newline_pos.is_some() {
            return Ok(Some((String::from_utf8_lossy(&out).to_string(), truncated)));
        }
    }
}

/// 流式文本合并的定时 flush 间隔。partial 模式 (`claude --include-partial-messages`)
/// 一 token 一 stream_event, 后端做帧级合并后, `agent-chunk` IPC emit 频率从
/// "每 token 一次" 降到 "每 flush 一次"。200ms (~5fps): 配合前端
/// syncLiveMessageState 的 fast path (每事件 O(1) swap), 大幅减少 IPC 与前端
/// store set 次数, 视觉顿挫可接受 (burst 间隙无感)。stop 时末尾 200ms 文本可能
/// 成 late data 被 UI 丢弃 (DB 仍持久化, 重载可见)。
/// EOF / 工具边界 / 64KB burst 仍强制 flush, 保证数据不丢。
pub const STREAM_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

/// 合并 buffer 的硬上限 ── burst 期间持续高速文�?���? 超过此值立�?flush,
/// 既防 buffer 无限增长, 也避免单条合�?chunk 过大�?4 KiB 远大于一帧的文本�?
/// 正常�?��不会触达�?
pub const STREAM_FLUSH_MAX_BYTES: usize = 64 * 1024;

/// 帧级文本合并 buffer ── 把高�?`Text` / `Reasoning` chunk 攒批, 减少
/// `emit_chunk_with_run_id` �?IPC 次数�?///
/// 顺序不变�? `Text` / `Reasoning` �?buffer; 其它 chunk (`ToolCall` /
/// `ToolResult` / `Error` / `SessionResolved` / `Usage` / ...) 鐢辫皟鐢ㄦ柟鍏堣皟
/// [`flush`](Self::flush) 拿走缓冲文本 emit, �?emit �?chunk, 保证
/// `text -> tool_call -> text -> tool_result -> text` 鐨勫憟鐜伴『搴忎笌鍚庣鍙戝嚭椤哄簭
/// 一致。`flush` 先产�?`Reasoning` 再产�?`Text`, 与前�?`streaming-buffer` �?/// reasoning-first �?��对齐 (reasoning chunk 先于 text 出现, text 落地�?close
/// reasoning 琛?銆?///
/// �?thread / �?run: 每个 stdout 读取�?��持有�?��实例, 无需并发保护。`flush`
/// 返回 `Vec<AgentChunk>` 而非直接 emit ── �?IPC 交给调用�?(沿用
/// `emit_chunk_with_run_id`), buffer �?��保持�?��辑、可单测�?
pub struct StreamingEmitBuffer {
    thread_id: String,
    text: String,
    reasoning: String,
    text_metadata: Option<AgentChunkMetadata>,
    reasoning_metadata: Option<AgentChunkMetadata>,
}

impl StreamingEmitBuffer {
    pub fn new(thread_id: String) -> Self {
        Self {
            thread_id,
            text: String::new(),
            reasoning: String::new(),
            text_metadata: None,
            reasoning_metadata: None,
        }
    }

    /// 当前缓冲的文�?��节数。调用方�??判断�?��该在阈值�?强制 flush�?
    pub fn pending_bytes(&self) -> usize {
        self.text.len() + self.reasoning.len()
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.reasoning.is_empty()
    }

    pub fn has_text(&self) -> bool {
        !self.text.is_empty()
    }

    pub fn has_reasoning(&self) -> bool {
        !self.reasoning.is_empty()
    }

    #[allow(dead_code)]
    pub fn append_text(&mut self, text: &str) {
        self.append_text_with_metadata(text, AgentChunkMetadata::default());
    }

    #[allow(dead_code)]
    pub fn append_reasoning(&mut self, text: &str) {
        self.append_reasoning_with_metadata(text, AgentChunkMetadata::default());
    }

    pub fn append_text_with_metadata(&mut self, text: &str, metadata: AgentChunkMetadata) {
        if self.text_metadata.is_none() {
            self.text_metadata = Some(metadata);
        }
        self.text.push_str(text);
    }

    pub fn append_reasoning_with_metadata(&mut self, text: &str, metadata: AgentChunkMetadata) {
        if self.reasoning_metadata.is_none() {
            self.reasoning_metadata = Some(metadata);
        }
        self.reasoning.push_str(text);
    }

    pub fn text_message_id(&self) -> Option<&str> {
        self.text_metadata
            .as_ref()
            .and_then(|metadata| metadata.message_id.as_deref())
    }

    pub fn reasoning_message_id(&self) -> Option<&str> {
        self.reasoning_metadata
            .as_ref()
            .and_then(|metadata| metadata.message_id.as_deref())
    }

    /// 取走缓冲文本, �?reasoning �?text, 各自拼成单条 `AgentChunk` 返回�?    /// 空缓冲返回空 vec (调用方无需判空)�?
    #[allow(dead_code)]
    pub fn flush(&mut self) -> Vec<AgentChunk> {
        self.flush_with_metadata()
            .into_iter()
            .map(|(chunk, _)| chunk)
            .collect()
    }

    pub fn flush_with_metadata(&mut self) -> Vec<(AgentChunk, AgentChunkMetadata)> {
        let mut out = Vec::new();
        if !self.reasoning.is_empty() {
            out.push((
                AgentChunk::Reasoning {
                    thread_id: self.thread_id.clone(),
                    text: std::mem::take(&mut self.reasoning),
                },
                self.reasoning_metadata.take().unwrap_or_default(),
            ));
        }
        if !self.text.is_empty() {
            out.push((
                AgentChunk::Text {
                    thread_id: self.thread_id.clone(),
                    text: std::mem::take(&mut self.text),
                },
                self.text_metadata.take().unwrap_or_default(),
            ));
        }
        out
    }
}

pub async fn read_stderr_to_string<R>(
    thread_id: &str,
    expected_run_id: Option<&str>,
    runs: &ExternalRunRegistry,
    reader: R,
) -> Result<String, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut lines = reader.lines();
    let mut out = String::new();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        runs.touch(thread_id, expected_run_id).await;
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out)
}

/// Truncate `text` to at most `max_chars` Unicode chars, appending a sentinel
/// when truncation occurred. Used for log/preview fields that must stay bounded.
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}\n...[truncated]")
    } else {
        truncated
    }
}

/// Soft cap on text dropped into `runtime_log` / stderr-preview fields. Large
/// enough to diagnose, small enough to keep logs readable. Single source of
/// truth shared by every sidecar CLI.
pub const MAX_LOG_TEXT_CHARS: usize = 2048;

/// [`truncate_chars`] bound by [`MAX_LOG_TEXT_CHARS`] — the standard "preview
/// this for the log" helper shared by every sidecar CLI.
pub fn truncate_for_log(text: &str) -> String {
    truncate_chars(text, MAX_LOG_TEXT_CHARS)
}

/// Read a `BufReader<R>` to a single `String`. The async analogue of reading a
/// child's full stderr when no line-protocol parsing is needed.
pub async fn read_to_string<R>(reader: BufReader<R>) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut out = String::new();
    reader
        .read_to_string(&mut out)
        .await
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Derive a default thread title from the user prompt: collapse whitespace,
/// cap at 28 chars, fall back to `"{display_name} session"` when empty. Shared
/// by runtimes that do not get a title back from the CLI.
pub fn default_thread_title(display_name: &str, prompt: &str) -> String {
    let title = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        format!("{display_name} session")
    } else {
        title.chars().take(28).collect()
    }
}

/// Put an external-CLI child in its own process group so `kill_child_tree`
/// can signal the whole group (and its grandchildren) on Unix. No-op on
/// Windows, where `taskkill /T /F` already reaps the tree.
#[cfg(unix)]
pub fn configure_unix_process_group(cmd: &mut tokio::process::Command) {
    // `process_group(0)` => setpgid(0, 0): the child becomes leader of a new
    // group whose pgid == child pid. `kill_child_tree` then `kill(-pgid)` to
    // reap grandchildren (Node CLIs spawn their own shells/tools).
    cmd.as_std_mut().process_group(0);
}

#[cfg(not(unix))]
pub fn configure_unix_process_group(_cmd: &mut tokio::process::Command) {}

/// Kill an external-CLI child process tree. On Windows we use `taskkill /T /F`
/// to take down the whole tree (the child typically spawns its own helpers);
/// on Unix we signal the child's whole process group (set up at spawn via
/// `configure_unix_process_group`) so grandchildren are reaped too. Either
/// way we finish with `Child::kill` to also reap the leader handle.
pub async fn kill_child_tree(child: &mut Child, label: &str, thread_id: &str) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut cmd = Command::new("taskkill");
        crate::process_window::hide_command_window(&mut cmd);
        match cmd
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await
        {
            Ok(output) if output.status.success() => return,
            Ok(output) => tracing::warn!(
                "[{label}] taskkill failed for {thread_id}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(err) => tracing::warn!("[{label}] failed to run taskkill for {thread_id}: {err}"),
        }
    }

    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The child was spawned with `process_group(0)`, so it leads a new
        // process group whose pgid == its pid. Signal the whole group to reap
        // grandchildren (Node CLIs spawn their own shells/tools); a bare
        // `child.kill()` would orphan them. SIGTERM for a graceful chance,
        // then SIGKILL. We still fall through to `child.kill()` below to reap
        // the leader handle.
        let pgid = pid as i32;
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGTERM);
            let _ = libc::kill(-pgid, libc::SIGKILL);
        }
    }

    if let Err(err) = child.kill().await {
        tracing::warn!("[{label}] failed to kill child for {thread_id}: {err}");
    }
}
