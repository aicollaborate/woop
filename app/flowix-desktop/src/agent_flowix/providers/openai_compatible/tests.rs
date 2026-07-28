//! Regression tests for the parallel `tool_calls` parser.
//!
//! The pre-fix parser used a single `PendingToolCall` bucket and ignored
//! the LLM-assigned `index` field, so when the LLM emitted N parallel
//! `tool_calls` in one delta they were all clobbered into one bucket 鈥?    //! their `arguments` strings concatenated and only the last `id`
//! survived. The gateway then rejected the next turn with 400
//! "invalid function arguments json string".
//!
//! These tests exercise the same `merge_tool_call_delta` /
//! `flush_pending_tool_calls` free functions the runtime `unfold`
//! closure calls, so a fix in one propagates to the other.
use std::io::Cursor;

use image::GenericImageView;
use rllm::FunctionCall as LlmFunctionCall;

use super::constants::MAX_IMAGE_DIMENSION;
use super::types::{ApiStreamFunction, ApiStreamToolCall};
use super::*;

fn tc(index: usize, id: &str, name: &str, args: &str) -> ApiStreamToolCall {
    ApiStreamToolCall {
        index: Some(index),
        id: Some(id.to_string()),
        call_type: Some("function".to_string()),
        function: Some(ApiStreamFunction {
            name: Some(name.to_string()),
            arguments: Some(args.to_string()),
        }),
    }
}

fn tc_args(index: usize, args: &str) -> ApiStreamToolCall {
    ApiStreamToolCall {
        index: Some(index),
        id: None,
        call_type: None,
        function: Some(ApiStreamFunction {
            name: None,
            arguments: Some(args.to_string()),
        }),
    }
}

fn llm_tool_call(id: &str, name: &str, args: &str) -> LlmToolCall {
    LlmToolCall {
        id: id.to_string(),
        call_type: "function".to_string(),
        function: LlmFunctionCall {
            name: name.to_string(),
            arguments: args.to_string(),
        },
    }
}

#[test]
fn parallel_tool_calls_get_their_own_buckets() {
    // Simulate two parallel `read` tool_calls in one assistant turn:
    //  - index 0: id "call_A", args streaming
    //  - index 1: id "call_B", args streaming
    // Each call's args should land in its own bucket, NOT be concatenated.
    let mut pending = PendingToolCalls::new();
    merge_tool_call_delta(
        &mut pending,
        vec![
            tc(0, "call_A", "read", r#"{"#),
            tc(1, "call_B", "read", r#"{"#),
        ],
    );
    merge_tool_call_delta(
        &mut pending,
        vec![
            tc_args(0, r#""path":"a.md"}"#),
            tc_args(1, r#""path":"b.md"}"#),
        ],
    );
    let calls = flush_pending_tool_calls(&mut pending);

    assert_eq!(
        calls.len(),
        2,
        "expected 2 parallel tool calls, got {:?}",
        calls
    );
    assert_eq!(calls[0].id, "call_A");
    assert_eq!(calls[0].function.name, "read");
    assert_eq!(calls[0].function.arguments, r#"{"path":"a.md"}"#);
    assert_eq!(calls[1].id, "call_B");
    assert_eq!(calls[1].function.name, "read");
    assert_eq!(calls[1].function.arguments, r#"{"path":"b.md"}"#);

    // The cardinal regression check: pre-fix both buckets would have
    // ended up with the same concatenated string.
    assert_ne!(
        calls[0].function.arguments, calls[1].function.arguments,
        "arguments were collapsed 鈥?index keying is broken"
    );
}

#[test]
fn single_tool_call_still_works_when_index_omitted() {
    // Some providers omit `index` on single-tool-call responses.
    // The parser must default to index 0 so the call still lands in
    // a known bucket.
    let mut pending = PendingToolCalls::new();
    let mut call = tc(0, "call_X", "available_dirs", "{}");
    call.index = None; // simulate provider that omits the field
    merge_tool_call_delta(&mut pending, vec![call]);
    let calls = flush_pending_tool_calls(&mut pending);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_X");
    assert_eq!(calls[0].function.arguments, "{}");
}

#[test]
fn half_formed_buckets_are_skipped_at_flush() {
    // A bucket with no `name` (only a stray `id`) should be dropped
    // rather than emitted as a `ToolUseComplete` with empty function
    // name, which would crash the agent's tool dispatch.
    let mut pending = PendingToolCalls::new();
    merge_tool_call_delta(
        &mut pending,
        vec![ApiStreamToolCall {
            index: Some(0),
            id: Some("call_stray".to_string()),
            call_type: None,
            function: None,
        }],
    );
    let calls = flush_pending_tool_calls(&mut pending);
    assert!(
        calls.is_empty(),
        "half-formed bucket must be skipped, got {:?}",
        calls
    );
}

#[test]
fn three_parallel_calls_round_trip() {
    // Three calls in one turn 鈥?guards the upper end of the parallel
    // path. Order of emission must be ascending index.
    let mut pending = PendingToolCalls::new();
    merge_tool_call_delta(
        &mut pending,
        vec![
            tc(2, "call_C", "read", r#"{"id":"c"}"#),
            tc(0, "call_A", "read", r#"{"id":"a"}"#),
            tc(1, "call_B", "read", r#"{"id":"b"}"#),
        ],
    );
    let calls = flush_pending_tool_calls(&mut pending);
    assert_eq!(calls.len(), 3);
    // BTreeMap iterates in key order, so index 0 emits first.
    assert_eq!(calls[0].id, "call_A");
    assert_eq!(calls[1].id, "call_B");
    assert_eq!(calls[2].id, "call_C");
}

#[test]
fn extracts_markdown_remote_file_url_and_windows_image_paths() {
    let content = concat!(
            "鐪嬪浘 ![remote](https://example.com/a.png?x=1) ",
            "瑁搁摼 https://example.com/b.jpg, ",
            "file:///D:/imgs/c.jpeg ",
            "![asset](asset://localhost/C%3A%5CUsers%5CAdministrator%5CDocuments%5Cflowix%2Fattachments%5CSnipaste.png) ",
            "鏈湴 D:\\imgs\\nested dir\\d.png"
        );
    let sources = extract_image_sources(content);
    assert_eq!(
            sources,
            vec![
                "https://example.com/a.png?x=1",
                "asset://localhost/C%3A%5CUsers%5CAdministrator%5CDocuments%5Cflowix%2Fattachments%5CSnipaste.png",
                "https://example.com/b.jpg",
                "file:///D:/imgs/c.jpeg",
                "D:\\imgs\\nested dir\\d.png",
            ]
        );
}

#[test]
fn extracts_markdown_remote_file_url_and_windows_video_paths() {
    let content = concat!(
        "video [remote](https://example.com/a.mp4?x=1) ",
        "bare https://example.com/b.webm, ",
        "file:///D:/videos/c.mov ",
        "asset://localhost/C%3A%5CUsers%5CAdministrator%5CVideos%2Fd.m4v ",
        "local D:\\videos\\nested dir\\e.mp4"
    );
    let sources = extract_video_sources(content);
    assert_eq!(
        sources,
        vec![
            "https://example.com/a.mp4?x=1",
            "https://example.com/b.webm",
            "file:///D:/videos/c.mov",
            "asset://localhost/C%3A%5CUsers%5CAdministrator%5CVideos%2Fd.m4v",
            "D:\\videos\\nested dir\\e.mp4",
        ]
    );
}

#[test]
fn asset_url_decodes_to_windows_path() {
    let path = asset_url_to_path(
            "asset://localhost/C%3A%5CUsers%5CAdministrator%5CDocuments%5Cflowix%2Fattachments%5CSnipaste_2026-05-11_19-53-54.png",
        )
        .unwrap();
    assert_eq!(
            path.display().to_string(),
            "C:\\Users\\Administrator\\Documents\\flowix\\attachments\\Snipaste_2026-05-11_19-53-54.png"
        );
}

#[test]
fn resizes_image_to_max_1024_before_base64_encoding() {
    let image = image::DynamicImage::new_rgb8(2000, 1200);
    let mut input = Cursor::new(Vec::new());
    image.write_to(&mut input, image::ImageFormat::Png).unwrap();

    let data_url =
        encode_resized_image_data_url("local.png", &input.into_inner(), Some("image/png")).unwrap();
    let (_, encoded) = data_url.split_once(',').unwrap();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let output = image::load_from_memory(&decoded).unwrap();
    let (width, height) = output.dimensions();
    assert!(width <= MAX_IMAGE_DIMENSION);
    assert!(height <= MAX_IMAGE_DIMENSION);
    assert_eq!((width, height), (1024, 614));
}

#[tokio::test]
async fn prepare_messages_keeps_complete_tool_exchange() {
    let provider = OpenAICompatibleProvider::new(OpenAICompatibleConfig::new(
        "test-key",
        "test-model",
        "https://example.com/v1",
    ));
    let call = llm_tool_call("call_1", "read", r#"{"path":"a.md"}"#);
    let messages = provider
        .prepare_messages(&[
            LlmChatMessage {
                role: ChatRole::Assistant,
                content: String::new(),
                message_type: MessageType::ToolUse(vec![call.clone()]),
            }
            .into(),
            LlmChatMessage {
                role: ChatRole::User,
                content: r#"{"content":"ok"}"#.to_string(),
                message_type: MessageType::ToolResult(vec![llm_tool_call(
                    "call_1",
                    "tool_result",
                    r#"{"content":"ok"}"#,
                )]),
            }
            .into(),
        ])
        .await
        .unwrap();

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, "assistant");
    assert_eq!(messages[0].tool_calls.as_ref().unwrap()[0].id, call.id);
    assert_eq!(messages[1].role, "tool");
    assert_eq!(messages[1].tool_call_id.as_deref(), Some("call_1"));

    let assistant = serde_json::to_value(&messages[0]).unwrap();
    assert_eq!(assistant["content"], "Tool call requested.");
}

#[tokio::test]
async fn prepare_messages_omits_empty_system_and_text_rows() {
    let provider = OpenAICompatibleProvider::new(
        OpenAICompatibleConfig::new("test-key", "test-model", "https://example.com/v1")
            .with_system("  \n"),
    );
    let messages = provider
        .prepare_messages(&[
            LlmChatMessage {
                role: ChatRole::Assistant,
                content: String::new(),
                message_type: MessageType::Text,
            }
            .into(),
            LlmChatMessage {
                role: ChatRole::User,
                content: "hello".to_string(),
                message_type: MessageType::Text,
            }
            .into(),
        ])
        .await
        .unwrap();

    assert_eq!(messages.len(), 1);
    let value = serde_json::to_value(&messages[0]).unwrap();
    assert_eq!(value["role"], "user");
    assert_eq!(value["content"], "hello");
}

#[tokio::test]
async fn prepare_messages_replaces_empty_tool_result_content() {
    let provider = OpenAICompatibleProvider::new(OpenAICompatibleConfig::new(
        "test-key",
        "test-model",
        "https://example.com/v1",
    ));
    let call = llm_tool_call("call_1", "read", r#"{"path":"a.md"}"#);
    let messages = provider
        .prepare_messages(&[
            LlmChatMessage {
                role: ChatRole::Assistant,
                content: String::new(),
                message_type: MessageType::ToolUse(vec![call]),
            }
            .into(),
            LlmChatMessage {
                role: ChatRole::User,
                content: String::new(),
                message_type: MessageType::ToolResult(vec![llm_tool_call(
                    "call_1",
                    "tool_result",
                    "",
                )]),
            }
            .into(),
        ])
        .await
        .unwrap();

    let tool = serde_json::to_value(&messages[1]).unwrap();
    assert_eq!(tool["role"], "tool");
    assert_eq!(tool["content"], "{}");
}

#[tokio::test]
async fn prepare_messages_includes_reasoning_content_when_enabled() {
    let provider = OpenAICompatibleProvider::new(
        OpenAICompatibleConfig::new("test-key", "test-model", "https://example.com/v1")
            .with_reasoning_content(true),
    );
    let call = llm_tool_call("call_1", "read", r#"{"path":"a.md"}"#);
    let messages = provider
        .prepare_messages(&[
            OpenAICompatibleChatMessage {
                role: ChatRole::Assistant,
                content: String::new(),
                message_type: MessageType::ToolUse(vec![call]),
                reasoning: Some("I need to inspect the file first.".to_string()),
            },
            OpenAICompatibleChatMessage {
                role: ChatRole::User,
                content: r#"{"content":"ok"}"#.to_string(),
                message_type: MessageType::ToolResult(vec![llm_tool_call(
                    "call_1",
                    "tool_result",
                    r#"{"content":"ok"}"#,
                )]),
                reasoning: None,
            },
        ])
        .await
        .unwrap();
    let value = serde_json::to_value(&messages[0]).unwrap();

    assert_eq!(
        value["reasoning_content"],
        "I need to inspect the file first."
    );
}

#[tokio::test]
async fn prepare_messages_skips_orphan_tool_result() {
    let provider = OpenAICompatibleProvider::new(OpenAICompatibleConfig::new(
        "test-key",
        "test-model",
        "https://example.com/v1",
    ));
    let messages = provider
        .prepare_messages(&[
            LlmChatMessage {
                role: ChatRole::User,
                content: r#"{"content":"orphan"}"#.to_string(),
                message_type: MessageType::ToolResult(vec![llm_tool_call(
                    "call_orphan",
                    "tool_result",
                    r#"{"content":"orphan"}"#,
                )]),
            }
            .into(),
            LlmChatMessage {
                role: ChatRole::User,
                content: "continue".to_string(),
                message_type: MessageType::Text,
            }
            .into(),
        ])
        .await
        .unwrap();

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "user");
    assert!(messages[0].tool_call_id.is_none());
}

#[tokio::test]
async fn prepare_messages_skips_incomplete_tool_exchange() {
    let provider = OpenAICompatibleProvider::new(OpenAICompatibleConfig::new(
        "test-key",
        "test-model",
        "https://example.com/v1",
    ));
    let messages = provider
        .prepare_messages(&[
            LlmChatMessage {
                role: ChatRole::Assistant,
                content: String::new(),
                message_type: MessageType::ToolUse(vec![llm_tool_call(
                    "call_1",
                    "read",
                    r#"{"path":"a.md"}"#,
                )]),
            }
            .into(),
            LlmChatMessage {
                role: ChatRole::User,
                content: "interrupted".to_string(),
                message_type: MessageType::Text,
            }
            .into(),
            LlmChatMessage {
                role: ChatRole::User,
                content: r#"{"content":"late"}"#.to_string(),
                message_type: MessageType::ToolResult(vec![llm_tool_call(
                    "call_1",
                    "tool_result",
                    r#"{"content":"late"}"#,
                )]),
            }
            .into(),
        ])
        .await
        .unwrap();

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "user");
    assert!(messages[0].tool_calls.is_none());
}

#[tokio::test]
async fn local_markdown_image_stays_text_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sample.png");
    let image = image::DynamicImage::new_rgb8(16, 16);
    image.save(&path).unwrap();

    let provider = OpenAICompatibleProvider::new(OpenAICompatibleConfig::new(
        "test-key",
        "test-model",
        "https://example.com/v1",
    ));
    let message = LlmChatMessage {
        role: ChatRole::User,
        content: format!("描述这张�?![sample]({})", path.display()),
        message_type: MessageType::Text,
    };
    let messages = provider.prepare_messages(&[message.into()]).await.unwrap();
    let value = serde_json::to_value(&messages[0]).unwrap();
    let content = value.get("content").and_then(|v| v.as_str()).unwrap();
    assert!(content.contains(&path.display().to_string()));
}

#[tokio::test]
async fn local_markdown_image_becomes_openai_multimodal_content_when_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sample.png");
    let image = image::DynamicImage::new_rgb8(16, 16);
    image.save(&path).unwrap();

    let provider = OpenAICompatibleProvider::new(
        OpenAICompatibleConfig::new("test-key", "test-model", "https://example.com/v1")
            .with_multimodal_user_content(true),
    );
    let message = LlmChatMessage {
        role: ChatRole::User,
        content: format!("鎻忚�?��欏紶�?![sample]({})", path.display()),
        message_type: MessageType::Text,
    };
    let messages = provider.prepare_messages(&[message.into()]).await.unwrap();
    let value = serde_json::to_value(&messages[0]).unwrap();
    let content = value.get("content").and_then(|v| v.as_array()).unwrap();
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "image_url");
    assert!(content[1]["image_url"]["url"]
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
}

#[tokio::test]
async fn remote_video_becomes_openai_multimodal_content_when_enabled() {
    let provider = OpenAICompatibleProvider::new(
        OpenAICompatibleConfig::new("test-key", "test-model", "https://example.com/v1")
            .with_multimodal_user_content(true),
    );
    let message = LlmChatMessage {
        role: ChatRole::User,
        content: "describe this video https://example.com/demo.mp4?token=1".to_string(),
        message_type: MessageType::Text,
    };
    let messages = provider.prepare_messages(&[message.into()]).await.unwrap();
    let value = serde_json::to_value(&messages[0]).unwrap();
    let content = value.get("content").and_then(|v| v.as_array()).unwrap();
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "video_url");
    assert_eq!(
        content[1]["video_url"]["url"],
        "https://example.com/demo.mp4?token=1"
    );
}

#[tokio::test]
async fn local_video_becomes_data_url_when_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sample.mp4");
    std::fs::write(&path, b"fake mp4 bytes").unwrap();

    let provider = OpenAICompatibleProvider::new(
        OpenAICompatibleConfig::new("test-key", "test-model", "https://example.com/v1")
            .with_multimodal_user_content(true),
    );
    let message = LlmChatMessage {
        role: ChatRole::User,
        content: format!("describe this video [sample]({})", path.display()),
        message_type: MessageType::Text,
    };
    let messages = provider.prepare_messages(&[message.into()]).await.unwrap();
    let value = serde_json::to_value(&messages[0]).unwrap();
    let content = value.get("content").and_then(|v| v.as_array()).unwrap();
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "video_url");
    assert!(content[1]["video_url"]["url"]
        .as_str()
        .unwrap()
        .starts_with("data:video/mp4;base64,"));
}
