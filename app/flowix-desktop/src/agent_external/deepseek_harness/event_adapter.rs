use super::protocol::ThinkingSegment;
use crate::agent_external::{AgentChunkMetadata, StreamingEmitBuffer};

pub(crate) fn append_thinking_segments(
    buffer: &mut StreamingEmitBuffer,
    segments: Vec<ThinkingSegment>,
    assistant_segment: u64,
) {
    append_thinking_segments_with_metadata(buffer, segments, assistant_segment, None);
}

pub(crate) fn append_thinking_segments_with_metadata(
    buffer: &mut StreamingEmitBuffer,
    segments: Vec<ThinkingSegment>,
    assistant_segment: u64,
    base_metadata: Option<&AgentChunkMetadata>,
) {
    for segment in segments {
        let mut metadata = base_metadata.cloned().unwrap_or_default();
        if metadata.source_message_id.is_none() {
            metadata.source_message_id = Some(format!("assistant-stream-{assistant_segment}"));
        }
        match segment {
            ThinkingSegment::Text(text) => buffer.append_text_with_metadata(&text, metadata),
            ThinkingSegment::Reasoning(text) => {
                buffer.append_reasoning_with_metadata(&text, metadata)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_kind_and_assigns_one_segment_identity() {
        let mut buffer = StreamingEmitBuffer::new("thread-1".to_string());
        append_thinking_segments(
            &mut buffer,
            vec![
                ThinkingSegment::Reasoning("why".into()),
                ThinkingSegment::Text("answer".into()),
            ],
            7,
        );
        let chunks = buffer.flush_with_metadata();
        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().all(
            |(_, metadata)| metadata.source_message_id.as_deref() == Some("assistant-stream-7")
        ));
    }
}
