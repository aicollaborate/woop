use super::protocol::ThinkingSegment;
use crate::agent_external::{AgentChunkMetadata, StreamingEmitBuffer};

pub(crate) fn append_thinking_segments(
    buffer: &mut StreamingEmitBuffer,
    segments: Vec<ThinkingSegment>,
    assistant_segment: u64,
) {
    let source_message_id = format!("assistant-stream-{assistant_segment}");
    for segment in segments {
        let metadata = AgentChunkMetadata {
            source_message_id: Some(source_message_id.clone()),
            ..AgentChunkMetadata::default()
        };
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
