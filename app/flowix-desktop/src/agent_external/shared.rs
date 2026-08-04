use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Child;
#[cfg(windows)]
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::agent_flowix::{AgentChunk, AgentUserMessage, RunInfo};
use crate::agent_session::{ChatMessage, NewAgentExternalEvent, ThreadManager};
use crate::events as dispatcher;
use crate::runtime_log;

mod lifecycle;
mod process_io;
mod runtime;

pub use lifecycle::*;
#[cfg(test)]
use lifecycle::{default_raw_json_enabled, parse_env_bool};
pub use process_io::*;
pub use runtime::*;

/// Fill in `AgentChunkMetadata` defaults shared by every external runtime.
///
/// `fold_reasoning` collapses all reasoning chunks in one run into a single
/// stable `reasoning-{run_id}` id (Claude: the UI models one product run as
/// one expandable reasoning row). When false (Codex), each reasoning chunk
/// keeps its own `{run_id}-{seq}-{subseq}` id like assistant text.
pub fn complete_chunk_metadata(
    fold_reasoning: bool,
    mut metadata: AgentChunkMetadata,
    chunk: &AgentChunk,
    run_id: &str,
    source_timestamp: i64,
    source_sequence: u64,
    source_subsequence: u32,
) -> AgentChunkMetadata {
    if fold_reasoning && matches!(chunk, AgentChunk::Reasoning { .. }) {
        metadata.message_id = Some(format!("reasoning-{run_id}"));
    } else if metadata.message_id.is_none() {
        let kind = match chunk {
            AgentChunk::Text { .. } => Some("assistant"),
            AgentChunk::Reasoning { .. } => Some("reasoning"),
            _ => None,
        };
        if let Some(kind) = kind {
            metadata.message_id = Some(format!(
                "{kind}-{run_id}-{source_sequence}-{source_subsequence}"
            ));
        }
    }
    metadata.source_timestamp = Some(source_timestamp);
    metadata.source_sequence = Some(source_sequence);
    metadata.source_subsequence = Some(source_subsequence);
    metadata
}

/// Canonicalize provider-owned transcript rows that were created outside a
/// Flowix run. The provider message id is the stable source key; each user row
/// starts a deterministic imported run for the following assistant/tool rows.
pub fn canonicalize_imported_messages(
    agent_type: &str,
    session_id: &str,
    messages: &mut [ChatMessage],
) {
    let mut run_id = format!("import:{session_id}:orphan");
    for message in messages {
        let source_message_id = message.id.clone();
        if message.role == "user" {
            run_id = format!("import:{session_id}:{source_message_id}");
        }
        let role = match message.role.as_str() {
            "user" => "user",
            "reasoning" => "reasoning",
            "tool" => "tool",
            _ => "assistant",
        };
        message.id = canonical_message_id(agent_type, &run_id, role, &source_message_id);
        if let Some(tool_call_id) = message.tool_call_id.as_ref() {
            message.tool_call_id = Some(canonical_message_id(
                agent_type,
                &run_id,
                "tool-call",
                tool_call_id,
            ));
        }
    }
}

/// Turn-level event compaction shared by the Claude and Codex runtimes.
///
/// Accumulates chunks within one turn, de-duplicating tool calls / results /
/// usage by id. The text merge strategy differs per runtime (Claude appends
/// unless a snapshot arrives; Codex replaces the whole row), so text handling
/// stays in each runtime's own `observe_*_turn` helper. OpenCode uses a
/// different shape (single-slot indexes + `close_streaming_rows`) and is not
/// shared here.
#[derive(Default)]
pub struct TurnEvents {
    pub events: Vec<(AgentChunk, AgentChunkMetadata)>,
    pub message_indexes: HashMap<String, usize>,
    pub tool_call_indexes: HashMap<String, usize>,
    pub tool_result_indexes: HashMap<String, usize>,
    pub usage_index: Option<usize>,
    pub next_message_id: usize,
}

impl TurnEvents {
    pub fn observe_tool_call(&mut self, chunk: &AgentChunk, metadata: &AgentChunkMetadata) {
        if let AgentChunk::ToolCall { id, .. } = chunk {
            if let Some(index) = self.tool_call_indexes.get(id).copied() {
                self.events[index] = (chunk.clone(), metadata.clone());
            } else {
                self.tool_call_indexes.insert(id.clone(), self.events.len());
                self.events.push((chunk.clone(), metadata.clone()));
            }
        }
    }

    pub fn observe_tool_result(&mut self, chunk: &AgentChunk, metadata: &AgentChunkMetadata) {
        if let AgentChunk::ToolResult { id, .. } = chunk {
            if let Some(index) = self.tool_result_indexes.get(id).copied() {
                self.events[index] = (chunk.clone(), metadata.clone());
            } else {
                self.tool_result_indexes.insert(id.clone(), self.events.len());
                self.events.push((chunk.clone(), metadata.clone()));
            }
        }
    }

    pub fn observe_usage(&mut self, chunk: &AgentChunk, metadata: &AgentChunkMetadata) {
        if let AgentChunk::Usage { .. } = chunk {
            if let Some(index) = self.usage_index {
                self.events[index] = (chunk.clone(), metadata.clone());
            } else {
                self.usage_index = Some(self.events.len());
                self.events.push((chunk.clone(), metadata.clone()));
            }
        }
    }

    pub fn observe_error(&mut self, chunk: &AgentChunk, metadata: &AgentChunkMetadata) {
        if let AgentChunk::Error { .. } = chunk {
            self.events.push((chunk.clone(), metadata.clone()));
        }
    }
}

#[cfg(test)]
mod tests;
