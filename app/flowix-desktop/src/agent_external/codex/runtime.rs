//! Codex-specific runtime helpers kept inside the `codex` module because they
//! gate on a Codex-named env var. Generic chunk emission lives in
//! `crate::agent_external` and is reused by the Codex persistence adapter.

use crate::agent_external::{
    emit_chunk_with_run_id, persist_external_chunk_for_thread_with_metadata, AgentChunkMetadata,
};

use std::sync::Arc;

use crate::agent_flowix::AgentChunk;
use crate::agent_session::ThreadManager;

pub fn diagnostics_enabled() -> bool {
    std::env::var("FLOWIX_CODEX_DIAGNOSTICS")
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            value == "1" || value == "true" || value == "yes" || value == "on"
        })
        .unwrap_or_else(|_| cfg!(debug_assertions))
}

pub async fn persist_codex_chunk(
    thread_manager: &Arc<ThreadManager>,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
) {
    persist_codex_chunk_with_metadata(
        thread_manager,
        chunk,
        run_id,
        raw_json,
        &AgentChunkMetadata::default(),
    )
    .await;
}

pub async fn persist_codex_chunk_with_metadata(
    thread_manager: &Arc<ThreadManager>,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
    metadata: &AgentChunkMetadata,
) {
    let storage_thread_id = thread_manager
        .find_thread_by_external_session(chunk.thread_id(), super::AGENT_TYPE)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| chunk.thread_id().to_string());
    persist_external_chunk_for_thread_with_metadata(
        thread_manager,
        super::AGENT_TYPE,
        &storage_thread_id,
        chunk,
        run_id,
        raw_json,
        metadata,
    )
    .await;
}

pub async fn persist_and_emit_codex_chunk(
    app_handle: &tauri::AppHandle,
    thread_manager: &Arc<ThreadManager>,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
) {
    persist_codex_chunk(thread_manager, chunk, run_id, raw_json).await;
    emit_chunk_with_run_id(app_handle, chunk, super::AGENT_TYPE, run_id);
}
