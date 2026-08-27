use super::event_adapter::append_thinking_segments;
use super::protocol::{AdaptedEvent, ThinkingSegment, ThinkingTagParser};
use crate::agent_external::{AgentChunkMetadata, StreamingEmitBuffer};
use crate::agent_wire::AgentChunk;

pub(crate) enum Projection {
    Buffered,
    Boundary {
        buffered: Vec<(AgentChunk, AgentChunkMetadata)>,
        chunk: AgentChunk,
        metadata: AgentChunkMetadata,
    },
    Completed {
        buffered: Vec<(AgentChunk, AgentChunkMetadata)>,
        reason: Option<String>,
    },
}

pub(crate) struct RunEventProjector {
    buffer: StreamingEmitBuffer,
    thinking: ThinkingTagParser,
    assistant_segment: u64,
}

impl RunEventProjector {
    pub(crate) fn new(thread_id: String) -> Self {
        Self {
            buffer: StreamingEmitBuffer::new(thread_id),
            thinking: ThinkingTagParser::new(),
            assistant_segment: 0,
        }
    }
    pub(crate) fn accept(&mut self, event: AdaptedEvent) -> Projection {
        match event {
            AdaptedEvent::Chunk(AgentChunk::Text { text, .. }) => {
                append_thinking_segments(
                    &mut self.buffer,
                    self.thinking.push(&text),
                    self.assistant_segment,
                );
                Projection::Buffered
            }
            AdaptedEvent::Chunk(AgentChunk::Reasoning { text, .. }) => {
                append_thinking_segments(
                    &mut self.buffer,
                    vec![ThinkingSegment::Reasoning(text)],
                    self.assistant_segment,
                );
                Projection::Buffered
            }
            AdaptedEvent::Chunk(chunk) => {
                append_thinking_segments(
                    &mut self.buffer,
                    self.thinking.flush_pending(),
                    self.assistant_segment,
                );
                let buffered = self.buffer.flush_with_metadata();
                if matches!(chunk, AgentChunk::ToolCall { .. }) {
                    self.assistant_segment = self.assistant_segment.saturating_add(1);
                }
                Projection::Boundary {
                    buffered,
                    metadata: AgentChunkMetadata {
                        reasoning_boundary: matches!(chunk, AgentChunk::ToolCall { .. }),
                        ..AgentChunkMetadata::default()
                    },
                    chunk,
                }
            }
            AdaptedEvent::Completed(reason) => {
                append_thinking_segments(
                    &mut self.buffer,
                    self.thinking.finish(),
                    self.assistant_segment,
                );
                Projection::Completed {
                    buffered: self.buffer.flush_with_metadata(),
                    reason,
                }
            }
            AdaptedEvent::Ignore => Projection::Buffered,
        }
    }
    pub(crate) fn flush(&mut self) -> Vec<(AgentChunk, AgentChunkMetadata)> {
        self.buffer.flush_with_metadata()
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }
    pub(crate) fn finish(&mut self) -> Vec<(AgentChunk, AgentChunkMetadata)> {
        append_thinking_segments(
            &mut self.buffer,
            self.thinking.finish(),
            self.assistant_segment,
        );
        self.buffer.flush_with_metadata()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_boundary_flushes_text_and_advances_assistant_identity() {
        let mut projector = RunEventProjector::new("t".into());
        projector.accept(AdaptedEvent::Chunk(AgentChunk::Text {
            thread_id: "t".into(),
            text: "before".into(),
        }));
        let boundary = projector.accept(AdaptedEvent::Chunk(AgentChunk::ToolCall {
            thread_id: "t".into(),
            id: "c1".into(),
            name: "read".into(),
            input: serde_json::Value::Null,
        }));
        let Projection::Boundary { buffered, .. } = boundary else {
            panic!("expected boundary")
        };
        assert_eq!(
            buffered[0].1.source_message_id.as_deref(),
            Some("assistant-stream-0")
        );
        projector.accept(AdaptedEvent::Chunk(AgentChunk::Text {
            thread_id: "t".into(),
            text: "after".into(),
        }));
        assert_eq!(
            projector.flush()[0].1.source_message_id.as_deref(),
            Some("assistant-stream-1")
        );
    }

    #[test]
    fn completion_flushes_pending_thinking_markup() {
        let mut projector = RunEventProjector::new("t".into());
        projector.accept(AdaptedEvent::Chunk(AgentChunk::Text {
            thread_id: "t".into(),
            text: "<think>why".into(),
        }));
        let Projection::Completed { buffered, reason } =
            projector.accept(AdaptedEvent::Completed(Some("completed".into())))
        else {
            panic!("expected completion")
        };
        assert!(!buffered.is_empty());
        assert_eq!(reason.as_deref(), Some("completed"));
    }
}
