//! Tests in this module read or write process-global env vars
//! (`PATH`, `CLAUDE_NODE_PATH`, `CLAUDE_CODE_CLI_PATH`, 鈥?. These
//! mutations are process-wide and are visible to every other test
//! in the binary, so the tests must hold the shared external-agent
//! environment lock for the entire duration of the env access.
//!
//! **Convention:** any test that calls `std::env::var*` /
//! `std::env::set_var` / `std::env::remove_var` (or transitively
//! calls a helper that does) must start with
//!
//! ```ignore
//! let _guard = acquire_env_lock();
//! ```
//!
//! and hold `_guard` for the whole test body. Pure-function tests
//! (e.g. parsers, sort helpers) don't need the lock.
//!
//! The guard returned by [`acquire_env_lock`] is intentionally
//! `#[must_use]`-able via the leading `_guard =` binding 鈥?a missing
//! `_` (or just dropping it) will still hold the lock until the
//! function ends, so the binding just makes the intent obvious.
use super::super::events::{
    claude_event_to_chunks, claude_event_to_chunks_with_state, should_silence_event,
    silence_reason, ClaudeStreamState,
};
use super::*;
use crate::agent_external::acquire_test_env_lock as acquire_env_lock;

#[test]
fn appends_existing_images_as_claude_context() {
    let root =
        std::env::temp_dir().join(format!("flowix-claude-image-test-{}", std::process::id(),));
    std::fs::create_dir_all(&root).expect("create image test dir");
    let image = root.join("pasted.png");
    std::fs::write(&image, b"png").expect("create image");
    let prompt = append_attached_image_context(
        "describe this".to_string(),
        &[image.to_string_lossy().into_owned()],
    );
    assert!(prompt.contains("<attached_images>"));
    assert!(prompt.contains(&image.to_string_lossy().to_string()));
    cleanup(&root);
}

#[test]
fn maps_claude_assistant_text_to_chunk() {
    let value = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{ "type": "text", "text": "hello" }]
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Text { text, .. }] if text == "hello"
    ));
}

#[test]
fn maps_permission_modes() {
    assert_eq!(
        normalized_claude_permission_mode(Some("read-only")),
        Some("plan")
    );
    assert_eq!(
        normalized_claude_permission_mode(Some("workspace-write")),
        Some("acceptEdits")
    );
    assert_eq!(
        normalized_claude_permission_mode(Some("danger-full-access")),
        Some("bypassPermissions")
    );
    assert_eq!(
        normalized_claude_permission_mode(Some("yolo")),
        Some("bypassPermissions")
    );
    assert_eq!(normalized_claude_permission_mode(Some("inherit")), None);
}

#[test]
fn normalizes_claude_model_override() {
    assert_eq!(
        normalized_claude_model(Some("claude-sonnet-4-20250514")),
        Some("claude-sonnet-4-20250514")
    );
    assert_eq!(normalized_claude_model(Some(" inherit ")), None);
    assert_eq!(normalized_claude_model(Some("")), None);
    assert_eq!(normalized_claude_model(None), None);
}

#[test]
fn claude_command_adds_model_and_workspace_dirs() {
    let root = std::env::temp_dir().join(format!(
        "flowix-claude-workspace-test-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
    ));
    let cwd = root.join("primary");
    let secondary = root.join("secondary");
    let third = root.join("third");
    std::fs::create_dir_all(&cwd).expect("create primary dir");
    std::fs::create_dir_all(&secondary).expect("create secondary dir");
    std::fs::create_dir_all(&third).expect("create third dir");

    let workspace_paths = vec![
        cwd.to_string_lossy().to_string(),
        secondary.to_string_lossy().to_string(),
        secondary.to_string_lossy().to_string(),
        root.join("missing").to_string_lossy().to_string(),
        third.to_string_lossy().to_string(),
    ];
    let cmd = build_claude_command(
        None,
        &cwd,
        &workspace_paths,
        Some("workspace-write"),
        Some("claude-sonnet-4-20250514"),
    );
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "--permission-mode" && pair[1] == "acceptEdits"));
    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "--model" && pair[1] == "claude-sonnet-4-20250514"));
    assert_eq!(
        args.windows(2)
            .filter(|pair| pair[0] == "--add-dir")
            .map(|pair| pair[1].clone())
            .collect::<Vec<_>>(),
        vec![
            secondary.to_string_lossy().to_string(),
            third.to_string_lossy().to_string()
        ]
    );
    assert!(
        !args.iter().any(|arg| arg.is_empty()),
        "stdin carries the prompt; an empty positional is parsed as an empty --add-dir"
    );

    cleanup(&root);
}

#[test]
fn claude_command_maps_yolo_to_bypass_permissions() {
    let cwd = std::env::temp_dir();
    let workspace_paths = Vec::new();
    let cmd = build_claude_command(None, &cwd, &workspace_paths, Some("yolo"), None);
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "--permission-mode" && pair[1] == "bypassPermissions"));
    assert!(!args.iter().any(|arg| arg == "--yolo"));
}

#[test]
fn parse_claude_stdout_line_extracts_session_and_text() {
    let parsed = parse_claude_stdout_line(
        "thread_1",
        r#"{"type":"assistant","session_id":"019f0000-0000-7000-8000-000000000000","message":{"content":[{"type":"text","text":"hello"}]}}"#,
    );

    assert_eq!(
        parsed.session_id.as_deref(),
        Some("019f0000-0000-7000-8000-000000000000")
    );
    assert!(matches!(
        parsed.chunks.as_slice(),
        [AgentChunk::Text { thread_id, text }] if thread_id == "thread_1" && text == "hello"
    ));
}

#[test]
fn parse_claude_stdout_line_keeps_non_json_as_text() {
    let parsed = parse_claude_stdout_line("thread_1", "plain progress");

    assert!(parsed.value.is_none());
    assert!(parsed.session_id.is_none());
    assert!(matches!(
        parsed.chunks.as_slice(),
        [AgentChunk::Text { text, .. }] if text == "plain progress\n"
    ));
}

#[test]
fn parse_claude_stdout_line_maps_system_error() {
    let parsed = parse_claude_stdout_line(
        "thread_1",
        r#"{"type":"system","subtype":"error","message":"bad auth"}"#,
    );

    assert!(matches!(
        parsed.chunks.as_slice(),
        [AgentChunk::Error { message, .. }] if message == "bad auth"
    ));
}

#[test]
fn maps_claude_tool_blocks_to_chunks() {
    let assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{
                "type": "tool_use",
                "id": "toolu_1",
                "name": "Read",
                "input": { "file_path": "README.md" }
            }]
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &assistant);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolCall { id, name, input, .. }]
            if id == "toolu_1" && name == "Read" && input["file_path"] == "README.md"
    ));

    let user = serde_json::json!({
        "type": "user",
        "message": {
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": "file contents"
            }]
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &user);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { id, name, result, .. }]
            if id == "toolu_1" && name.is_empty() && result["content"] == "file contents"
    ));
}

#[test]
fn skips_user_text_but_keeps_tool_result_blocks_while_streaming() {
    let value = serde_json::json!({
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "text",
                    "text": "Plain user text before a tool result"
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "loaded"
                }
            ]
        }
    });

    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { id, result, .. }]
            if id == "toolu_1"
            && result["content"] == "loaded"
    ));
}

#[test]
fn user_tool_result_only_content_emits_tool_result_chunk() {
    // type=user �?content array 里只�?tool_result �?�?text)�?
    // �?�� ToolResult 一�?chunk,与原�?�� tool_result 处理�?��一致�?
    let value = serde_json::json!({
        "type": "user",
        "message": {
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_2",
                "content": "file contents"
            }]
        }
    });

    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { id, result, .. }]
            if id == "toolu_2" && result["content"] == "file contents"
    ));
}

#[test]
fn user_image_block_is_silently_dropped() {
    // type=user �?content array �?image / attachment 等非 text/tool_result
    // 块时,不产生任�?chunk(没有 AgentChunk 变体�?��承载 user image)�?
    let value = serde_json::json!({
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "image",
                    "source": { "type": "base64", "media_type": "image/png", "data": "abc" }
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_3",
                    "content": "ok"
                }
            ]
        }
    });

    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { id, result, .. }]
            if id == "toolu_3" && result["content"] == "ok"
    ));
}

#[test]
fn drops_claude_synthetic_user_marker_while_streaming() {
    // 流式 stdout �?isSynthetic=true —Skill 工具调用成功�?harness
    // �?skill body 注入到主 agent �?user 消息里。�?字�?覆盖到了�?
    let stream_marker = serde_json::json!({
        "type": "user",
        "isSynthetic": true,
        "message": {
            "role": "user",
            "content": [{
                "type": "text",
                "text": "Base directory for this skill: /private/tmp/claude-501/bundled-skills/2.1.207/.../dataviz\n\n# Data Visualization\n\n..."
            }]
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &stream_marker);
    assert!(chunks.is_empty());

    // 持久�?JSONL �?isMeta=true —同一类消�?�� --resume / 压缩重建�?        // 的形态。同一 helper 应当兼�?�?
    let persistent_marker = serde_json::json!({
        "type": "user",
        "isMeta": true,
        "message": {
            "role": "user",
            "content": "[Your previous response had no visible output. Please continue.]"
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &persistent_marker);
    assert!(chunks.is_empty());
}

#[test]
fn emits_claude_subagent_event_while_streaming() {
    // 反向测试 —sub-agent 活动要展示在�?thread card �?带真实工具名�?        // ToolResult �?name 字�?�?stream.rs �?tool_use_id->name 映射�?��
    // (这里单测�?���?chunk emit, 不验�?name �?��)�?        // type=user + subagent_type(sub-agent tool_result) -> �?ToolResult
    let user_row = serde_json::json!({
        "type": "user",
        "subagent_type": "Explore",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_xxx",
                "content": "flowix"
            }]
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &user_row);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { id, .. }] if id == "toolu_xxx"
    ));

    // type=assistant + subagent_type(sub-agent tool_use) -> 鎺?ToolCall
    let assistant_tool_use = serde_json::json!({
        "type": "assistant",
        "subagent_type": "general-purpose",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "call_6e8f0e4380094c58b5748d38",
                "name": "Read",
                "input": { "file_path": "README.md" }
            }]
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &assistant_tool_use);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolCall { name, .. }] if name == "Read"
    ));

    // type=assistant + subagent_type(sub-agent text) -> 鎺?Text
    let assistant_text = serde_json::json!({
        "type": "assistant",
        "subagent_type": "general-purpose",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "sub-agent reply" }]
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &assistant_text);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Text { text, .. }] if text == "sub-agent reply"
    ));
}

#[test]
fn emits_subagent_spawn_tool_use_blocks_in_assistant_message() {
    // �?agent �?assistant 行里并�?调起多个 Agent (Task) sub-agent ──
    // 每个 tool_use 块�?应一�?spawn,�?thread card **应当**展示这些
    // tool_call 卡片(带真实工具名 "Agent")。文�?/ �?��工�?(Bash / Read)
    // 鍚屾牱姝ｅ父鍙戙€?
    let value = serde_json::json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [
                { "type": "text", "text": "let me run several analyses in parallel" },
                { "type": "tool_use", "id": "toolu_1", "name": "Agent",
                  "input": { "description": "Research Plausible and Umami" } },
                { "type": "tool_use", "id": "toolu_2", "name": "Agent",
                  "input": { "description": "Research Matomo and Cloudflare" } },
                { "type": "tool_use", "id": "toolu_3", "name": "Agent",
                  "input": { "description": "Research Fathom and Pirsch" } },
                { "type": "tool_use", "id": "toolu_4", "name": "Bash",
                  "input": { "command": "echo main" } }
            ]
        }
    });

    let chunks = claude_event_to_chunks("thread_1", &value);

    // 三个 Agent tool_use 全部展示�?ToolCall(name="Agent")
    let agent_count = chunks
        .iter()
        .filter(|c| matches!(c, AgentChunk::ToolCall { name, .. } if name == "Agent"))
        .count();
    assert_eq!(
        agent_count, 3,
        "should emit 3 Agent ToolCall chunks; got {}",
        agent_count
    );

    // text 鍧楁甯稿彂
    assert!(chunks.iter().any(|c| matches!(
        c, AgentChunk::Text { text, .. } if text == "let me run several analyses in parallel"
    )));

    // �?�?Bash tool_use 正常�?
    assert!(chunks.iter().any(|c| matches!(
        c, AgentChunk::ToolCall { name, .. } if name == "Bash"
    )));
}

#[test]
fn emits_agent_launch_metadata_tool_result() {
    // 反向测试 —"Async agent launched successfully" launch metadata
    // 也�? emit(�?thread card 展示 Agent tool 调起后的 launch 状�?�?        // content �?string �?array 两�?形�?都应正常�?ToolResult�?
    let string_form = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "call_e6e37468672748648ccf4b3e",
                "content": "Async agent launched successfully. placeholder"
            }]
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &string_form);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { ref id, .. }] if id == "call_e6e37468672748648ccf4b3e"
    ));

    let array_form = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "call_xx",
                "content": [{
                    "type": "text",
                    "text": "Async agent launched successfully. array form"
                }]
            }]
        }
    });
    let chunks = claude_event_to_chunks("thread_1", &array_form);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { ref id, .. }] if id == "call_xx"
    ));
}

#[test]
fn keeps_normal_tool_result_with_empty_name_unchanged() {
    // �?�?Bash / Read tool_result 即便�?name 字�?也应正常�?ToolResult
    // ── 后�?不臆�?��content �?"Async agent launched successfully"
    // 起头那条才丢,其他原样�?tool_result 一律照常。name 空字符串�?        // 流路径的固定行为,由前�?��定怎么 fallback�?
    let value = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": "file contents"
            }]
        }
    });

    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { id, result, .. }]
            if id == "toolu_1" && result["content"] == "file contents"
    ));
}

#[test]
fn emits_claude_sidechain_assistant_text_while_streaming() {
    // 反向测试 —isSidechain=true 标�?�?sub-agent 文本应�?常展示�?
    let value = serde_json::json!({
        "type": "assistant",
        "isSidechain": true,
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "sub-agent says hi" }]
        }
    });

    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Text { text, .. }] if text == "sub-agent says hi"
    ));
}

#[test]
fn emits_claude_sidechain_user_tool_result_while_streaming() {
    // 反向测试 —isSidechain=true 标�?�?sub-agent tool_result 应�?常展示�?
    let value = serde_json::json!({
        "type": "user",
        "isSidechain": true,
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": "sub-agent tool output"
            }]
        }
    });

    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { ref id, .. }] if id == "toolu_1"
    ));
}

#[test]
fn silence_reason_categorizes_each_filter_case() {
    // sub-agent / sidechain 杩囨护宸蹭粠 silence_reason 鎾ら櫎 (鐢ㄦ埛瑕佹眰灞曠ず
    // sub-agent 工具调用), 对应 helper 函数亦已删除。silence_reason 现在�?catch:
    //   1. synthetic_user_event 鈥?task-notification XML
    //   2. synthetic_user_marker 鈥?isSynthetic / isMeta / Skill body
    //
    // synthetic_user_event: origin.kind == "task-notification"
    let synthetic = serde_json::json!({
        "type": "user",
        "origin": { "kind": "task-notification" },
        "message": { "role": "user", "content": "<task-notification>x</task-notification>" }
    });
    assert_eq!(silence_reason(&synthetic), Some("synthetic_user_event"));

    // synthetic_user_marker: type=user + isSynthetic=true (流式) �?isMeta=true (JSONL)
    let stream_marker = serde_json::json!({
        "type": "user",
        "isSynthetic": true,
        "message": { "role": "user", "content": [{"type":"text","text":"skill body"}] }
    });
    assert_eq!(
        silence_reason(&stream_marker),
        Some("synthetic_user_marker")
    );

    let persistent_marker = serde_json::json!({
        "type": "user",
        "isMeta": true,
        "message": { "role": "user", "content": "[hidden reminder]" }
    });
    assert_eq!(
        silence_reason(&persistent_marker),
        Some("synthetic_user_marker")
    );

    let compact_summary_marker = serde_json::json!({
        "type": "user",
        "isVisibleInTranscriptOnly": true,
        "isCompactSummary": true,
        "message": {
            "role": "user",
            "content": [{
                "type": "text",
                "text": "This session is being continued from a previous conversation that ran out of context."
            }]
        }
    });
    assert_eq!(
        silence_reason(&compact_summary_marker),
        Some("synthetic_user_marker")
    );
    assert!(claude_event_to_chunks("thread_1", &compact_summary_marker).is_empty());

    let skill_injection = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "text",
                "text": "Base directory for this skill: C:\\Users\\Administrator\\AppData\\Local\\Temp\\claude\\bundled-skills\\2.1.199\\abc\\claude-api\n\n# Building LLM-Powered Applications with Claude"
            }]
        }
    });
    assert_eq!(
        silence_reason(&skill_injection),
        Some("synthetic_user_marker")
    );
    assert!(claude_event_to_chunks("thread_1", &skill_injection).is_empty());

    let malformed_skill_line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: C:\Users\Administrator\AppData\Local\Temp\claude\bundled-skills\2.1.199\d0c1b73065a070ff56cb23ffc36804fa\claude-api\n\n# Building LLM-Powered Applications with Claude"}]}}"#;
    assert!(parse_claude_stdout_line("thread_1", malformed_skill_line)
        .chunks
        .is_empty());

    // 反向�?��: sub-agent 活动 + �?��主链路都不应�? silence_reason �?        // (前者在 history/stream 两条 path 上都应�?�?emit, �?stream.rs �?        // tool_use_id->name 映射保证 ToolResult 拿到真实工具�?
    let subagent_user = serde_json::json!({
        "type": "user",
        "subagent_type": "Explore",
        "message": { "role": "user", "content": [{"type":"tool_result","tool_use_id":"x","content":"y"}] }
    });
    assert_eq!(silence_reason(&subagent_user), None);

    let subagent_assistant = serde_json::json!({
        "type": "assistant",
        "isSidechain": true,
        "message": { "role": "assistant", "content": [{"type":"tool_use","id":"x","name":"Read","input":{}}] }
    });
    assert_eq!(silence_reason(&subagent_assistant), None);

    // 主链�?assistant 不命�?
    let main = serde_json::json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "hello" }]
        }
    });
    assert_eq!(silence_reason(&main), None);
    assert!(!should_silence_event(&main));
}

#[test]
fn should_silence_event_agrees_with_silence_reason_is_some() {
    // 同一行任意两套谓词必须一�?—反向条件(history.rs 标�?检查用
    // should_silence_event,正向丢弃�?silence_reason)如果发生分�?�?        // 出现"�?��默但�?���?title 候�?�?应丢弃却渲染"的回归�?
    for value in [
        serde_json::json!({"type":"user","subagent_type":"Explore","message":{"role":"user","content":[]}}),
        serde_json::json!({"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[]}}),
        serde_json::json!({"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>x</task-notification>"}}),
        serde_json::json!({"type":"user","isSynthetic":true,"message":{"role":"user","content":[{"type":"text","text":"x"}]}}),
        serde_json::json!({"type":"user","isMeta":true,"message":{"role":"user","content":"x"}}),
        serde_json::json!({"type":"user","isVisibleInTranscriptOnly":true,"isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"This session is being continued from a previous conversation that ran out of context."}]}}),
        serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: C:\\Temp\\claude\\bundled-skills\\skill\n\n# Building LLM-Powered Applications with Claude"}]}}),
        serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}),
        serde_json::json!({"type":"user","message":{"role":"user","content":"real user prompt"}}),
    ] {
        assert_eq!(
            should_silence_event(&value),
            silence_reason(&value).is_some(),
            "predicate mismatch for {value}"
        );
    }
}

fn make_fake_executable(dir_suffix: &str, name: &str, body: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "flowix-claude-cli-test-{}-{}-{}",
        std::process::id(),
        dir_suffix,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let executable = dir.join(name);
    std::fs::write(&executable, body).expect("write fake executable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&executable)
            .expect("stat fake executable")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&executable, perms).expect("chmod fake executable");
    }
    (dir, executable)
}

#[test]
fn resolve_claude_node_binary_prefers_claude_node_path_env() {
    let _guard = acquire_env_lock();
    let (dir, fake_node) = make_fake_executable("node-env", "node", "#!/bin/sh\nexit 0\n");

    let original = std::env::var_os("CLAUDE_NODE_PATH");
    std::env::set_var("CLAUDE_NODE_PATH", &fake_node);
    let resolved = resolve_claude_node_binary();
    match original {
        Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
        None => std::env::remove_var("CLAUDE_NODE_PATH"),
    }
    cleanup(&dir);

    assert_eq!(resolved, Some(fake_node));
}

#[test]
fn resolve_claude_node_binary_finds_node_in_path() {
    let _guard = acquire_env_lock();
    let (dir, fake_node) = make_fake_executable("node-path", "node", "#!/bin/sh\nexit 0\n");

    let original_path = std::env::var_os("PATH");
    let original_node_env = std::env::var_os("CLAUDE_NODE_PATH");
    std::env::remove_var("CLAUDE_NODE_PATH");
    let sep = if cfg!(windows) { ';' } else { ':' };
    let joined = match &original_path {
        Some(path) => format!("{}{}{}", dir.display(), sep, path.to_string_lossy()),
        None => dir.display().to_string(),
    };
    std::env::set_var("PATH", joined);
    let resolved = resolve_claude_node_binary();
    match original_path {
        Some(value) => std::env::set_var("PATH", value),
        None => std::env::remove_var("PATH"),
    }
    match original_node_env {
        Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
        None => std::env::remove_var("CLAUDE_NODE_PATH"),
    }
    cleanup(&dir);

    assert_eq!(resolved, Some(fake_node));
}

#[test]
fn claude_command_launches_js_cli_through_node() {
    let _guard = acquire_env_lock();
    let (claude_dir, fake_claude_js) =
        make_fake_executable("js-cli", "claude.js", "#!/usr/bin/env node\n");
    let (node_dir, fake_node) = make_fake_executable("js-node", "node", "#!/bin/sh\nexit 0\n");

    let original_cli = std::env::var_os("CLAUDE_CODE_CLI_PATH");
    let original_node = std::env::var_os("CLAUDE_NODE_PATH");
    std::env::set_var("CLAUDE_CODE_CLI_PATH", &fake_claude_js);
    std::env::set_var("CLAUDE_NODE_PATH", &fake_node);

    let cwd = std::env::temp_dir();
    let cmd = build_claude_command(None, &cwd, &[], None, None);
    let program = cmd.as_std().get_program().to_string_lossy().to_string();
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();
    let expected_cli = std::fs::canonicalize(&fake_claude_js)
        .unwrap_or_else(|_| fake_claude_js.clone())
        .to_string_lossy()
        .to_string();

    match original_cli {
        Some(value) => std::env::set_var("CLAUDE_CODE_CLI_PATH", value),
        None => std::env::remove_var("CLAUDE_CODE_CLI_PATH"),
    }
    match original_node {
        Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
        None => std::env::remove_var("CLAUDE_NODE_PATH"),
    }
    cleanup(&claude_dir);
    cleanup(&node_dir);

    assert_eq!(program, fake_node.to_string_lossy());
    assert_eq!(
        args.first().map(String::as_str),
        Some(expected_cli.as_str())
    );
}

#[test]
fn preflight_claude_returns_friendly_error_when_no_node() {
    let _guard = acquire_env_lock();
    let (dir, fake_claude_js) =
        make_fake_executable("preflight-js", "claude.js", "#!/usr/bin/env node\n");

    let original_path = std::env::var_os("PATH");
    let original_node_env = std::env::var_os("CLAUDE_NODE_PATH");
    let original_cli_env = std::env::var_os("CLAUDE_CODE_CLI_PATH");
    std::env::remove_var("CLAUDE_NODE_PATH");
    std::env::set_var("PATH", "");
    std::env::set_var("CLAUDE_CODE_CLI_PATH", &fake_claude_js);

    let result = preflight_claude();

    match original_path {
        Some(value) => std::env::set_var("PATH", value),
        None => std::env::remove_var("PATH"),
    }
    match original_node_env {
        Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
        None => std::env::remove_var("CLAUDE_NODE_PATH"),
    }
    match original_cli_env {
        Some(value) => std::env::set_var("CLAUDE_CODE_CLI_PATH", value),
        None => std::env::remove_var("CLAUDE_CODE_CLI_PATH"),
    }
    cleanup(&dir);

    if let Err(message) = result {
        assert!(message.contains("Node.js"));
        assert!(message.contains("CLAUDE_NODE_PATH") || message.contains("nodejs.org"));
    }
}

#[tokio::test]
async fn real_claude_binary_smoke_test_opt_in() {
    if std::env::var("FLOWIX_RUN_REAL_CLAUDE_TESTS")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }

    preflight_claude().expect("claude preflight should pass");
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Command::new(resolve_claude_binary())
            .arg("--version")
            .output(),
    )
    .await
    .expect("claude --version timed out")
    .expect("failed to run claude --version");

    assert!(
        output.status.success(),
        "claude --version failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn cleanup(path: &std::path::Path) {
    let _ = std::fs::remove_dir_all(path);
}

#[test]
fn latest_versioned_subdir_prefers_high_major_over_lexicographic() {
    // Older Node left over from a long-ago install. A pure lexicographic
    // sort would compare '8' > '1' and wrongly resolve `swap_remove(last)`
    // to this old v8 directory. The semver-aware sort must pick v20.10.0.
    let parent = std::env::temp_dir().join(format!(
        "flowix-claude-cli-test-semver-major-{}",
        std::process::id(),
    ));
    std::fs::create_dir_all(&parent).expect("create temp dir");
    let v8 = parent.join("v8.17.0");
    let v18 = parent.join("v18.19.0");
    let v20 = parent.join("v20.10.0");
    for d in [&v8, &v18, &v20] {
        std::fs::create_dir_all(d).expect("create version dir");
    }
    // Non-version siblings must not poison the result.
    std::fs::create_dir_all(parent.join("latest")).expect("create latest dir");
    std::fs::create_dir_all(parent.join("current")).expect("create current dir");
    std::fs::write(parent.join("README.md"), "# readme").expect("write readme");

    let picked = latest_versioned_subdir(&parent);

    cleanup(&parent);

    assert_eq!(
        picked,
        Some(v20),
        "expected highest semver v20.10.0; got {:?} (lexicographic sort \
             would wrongly pick v8.17.0 since '8' > '1')",
        picked,
    );
}

#[test]
fn parse_node_version_handles_nvm_fnm_and_asdf_shapes() {
    // nvm / fnm use the `v`-prefixed shape.
    assert_eq!(parse_node_version("v20.10.0"), Some((20, 10, 0)));
    assert_eq!(parse_node_version("v18.19.0"), Some((18, 19, 0)));
    // asdf installs use the unprefixed shape.
    assert_eq!(parse_node_version("18.19.0"), Some((18, 19, 0)));
    // Pre-release suffix is truncated before parsing the leading triple.
    assert_eq!(parse_node_version("v20.0.0-rc.1"), Some((20, 0, 0)),);
    // Junk / non-semver / over-segmented names return None, not garbage.
    assert_eq!(parse_node_version("latest"), None);
    assert_eq!(parse_node_version("current"), None);
    assert_eq!(parse_node_version("v18"), None);
    assert_eq!(parse_node_version("18.19.0.foo"), None);
}

// ---- --include-partial-messages (stream_event) streaming tests ----
// partial 模式�?Claude Code 把回答拆�?Anthropic 原生 stream_event 增量;
// 涓嬪垪娴嬭瘯瑕嗙洊 text_delta / thinking_delta / tool_use input 绱Н / assistant
// �?��抑制 / message_delta usage, 对应 events::stream_event_to_chunks�?
#[test]
fn stream_event_text_delta_emits_incremental_text() {
    let value = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_delta", "index": 0,
            "delta": { "type": "text_delta", "text": "Hel" } }
    });
    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Text { text, .. }] if text == "Hel"
    ));
}

#[test]
fn stream_event_thinking_delta_emits_reasoning() {
    let value = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_delta", "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "step 1" } }
    });
    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Reasoning { text, .. }] if text == "step 1"
    ));
}

#[test]
fn stream_event_text_deltas_emit_one_chunk_per_fragment() {
    // 每个 text_delta �??量片�?-> 各自一�?Text chunk; 前�? append 还原全文�?
    let d1 = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_delta", "index": 0,
            "delta": { "type": "text_delta", "text": "1," } }
    });
    let d2 = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_delta", "index": 0,
            "delta": { "type": "text_delta", "text": " 2" } }
    });
    let mut state = ClaudeStreamState::default();
    let c1 = claude_event_to_chunks_with_state("thread_1", &d1, true, &mut state);
    let c2 = claude_event_to_chunks_with_state("thread_1", &d2, true, &mut state);
    assert!(matches!(c1.as_slice(), [AgentChunk::Text { text, .. }] if text == "1,"));
    assert!(matches!(c2.as_slice(), [AgentChunk::Text { text, .. }] if text == " 2"));
}

#[test]
fn stream_event_tool_use_accumulates_input_across_deltas() {
    // content_block_start(tool_use) + N x input_json_delta + content_block_stop
    // -> 单个 ToolCall, input 为合并后解析�?JSON。start / delta �?emit�?
    let mut state = ClaudeStreamState::default();
    let start = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_start", "index": 1,
            "content_block": { "type": "tool_use", "id": "toolu_1",
                "name": "Bash", "input": {} } }
    });
    let d1 = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_delta", "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"command\":" } }
    });
    let d2 = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_delta", "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": " \"echo hi\"}" } }
    });
    let stop = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_stop", "index": 1 }
    });

    assert!(claude_event_to_chunks_with_state("thread_1", &start, true, &mut state).is_empty());
    assert!(claude_event_to_chunks_with_state("thread_1", &d1, true, &mut state).is_empty());
    assert!(claude_event_to_chunks_with_state("thread_1", &d2, true, &mut state).is_empty());

    let chunks = claude_event_to_chunks_with_state("thread_1", &stop, true, &mut state);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolCall { id, name, input, .. }]
            if id == "toolu_1" && name == "Bash"
                && input.get("command").and_then(|v| v.as_str()) == Some("echo hi")
    ));
}

#[test]
fn partial_suppresses_assistant_snapshot_but_non_partial_emits() {
    // partial=true: 冗余�?���?��丢弃(delta 已驱动渲�?�?        // partial=false: 整�?文本照常 emit(回归保护)�?
    let assistant = serde_json::json!({
        "type": "assistant",
        "message": { "content": [{ "type": "text", "text": "hello" }] }
    });
    let mut state = ClaudeStreamState::default();
    assert!(claude_event_to_chunks_with_state("thread_1", &assistant, true, &mut state).is_empty());
    let chunks = claude_event_to_chunks_with_state("thread_1", &assistant, false, &mut state);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Text { text, .. }] if text == "hello"
    ));
}

#[test]
fn stream_event_message_delta_emits_usage() {
    let value = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": { "input_tokens": 974, "output_tokens": 3,
                "cache_read_input_tokens": 18432 } }
    });
    let chunks = claude_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Usage { usage: Some(u), .. }]
            if u.input_tokens == Some(974)
                && u.output_tokens == Some(3)
                && u.cached_input_tokens == Some(18432)
    ));
}

#[test]
fn partial_snapshot_reconciles_builtin_tool_use_without_stream_event() {
    // Claude Code 内置工具(WebSearch / Agent / TaskOutput)没有 stream_event
    // 增量,只出现在完整 type=assistant 快照里。partial 模式必须从快照补发
    // ToolCall(含完整 input),否则后续 tool_result(name 恒为空)会渲染成
    // "Unknown Tool"。
    let assistant = serde_json::json!({
        "type": "assistant",
        "message": { "content": [{
            "type": "tool_use", "id": "call_ws_1", "name": "WebSearch",
            "input": { "query": "cloudflare d1 limits" }
        }] }
    });
    let mut state = ClaudeStreamState::default();
    let chunks = claude_event_to_chunks_with_state("thread_1", &assistant, true, &mut state);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolCall { id, name, input, .. }]
            if id == "call_ws_1" && name == "WebSearch"
                && input.get("query").and_then(|v| v.as_str()) == Some("cloudflare d1 limits")
    ));
}

#[test]
fn partial_snapshot_skips_text_but_emits_tool_use() {
    let assistant = serde_json::json!({
        "type": "assistant",
        "message": { "content": [
            { "type": "text", "text": "searching now" },
            { "type": "tool_use", "id": "call_t_1", "name": "TaskOutput",
              "input": { "task_id": "abc", "block": true } }
        ] }
    });
    let mut state = ClaudeStreamState::default();
    // partial: text 已由 delta 渲染 -> 跳过;仅 tool_use 补发
    let partial_chunks =
        claude_event_to_chunks_with_state("thread_1", &assistant, true, &mut state);
    assert!(matches!(
        partial_chunks.as_slice(),
        [AgentChunk::ToolCall { id, name, .. }] if id == "call_t_1" && name == "TaskOutput"
    ));
    // 非 partial: text + tool_use 都照常 emit
    let mut state2 = ClaudeStreamState::default();
    let full_chunks = claude_event_to_chunks_with_state("thread_1", &assistant, false, &mut state2);
    assert_eq!(full_chunks.len(), 2);
    assert!(matches!(full_chunks[0], AgentChunk::Text { .. }));
    assert!(matches!(full_chunks[1], AgentChunk::ToolCall { .. }));
}

#[test]
fn partial_snapshot_does_not_duplicate_stream_event_tool_call() {
    // stream_event 增量已发过 id=toolu_1 的 ToolCall;同 id 再出现在完整快照里时
    // 不得重复发(否则前端两行 tool / tool_names 重复 insert)。
    let mut state = ClaudeStreamState::default();
    let start = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_start", "index": 0,
            "content_block": { "type": "tool_use", "id": "toolu_1",
                "name": "Bash", "input": {} } }
    });
    let stop = serde_json::json!({
        "type": "stream_event",
        "event": { "type": "content_block_stop", "index": 0 }
    });
    assert!(claude_event_to_chunks_with_state("thread_1", &start, true, &mut state).is_empty());
    let stop_chunks = claude_event_to_chunks_with_state("thread_1", &stop, true, &mut state);
    assert!(matches!(
        stop_chunks.as_slice(),
        [AgentChunk::ToolCall { id, .. }] if id == "toolu_1"
    ));

    let snapshot = serde_json::json!({
        "type": "assistant",
        "message": { "content": [
            { "type": "text", "text": "done" },
            { "type": "tool_use", "id": "toolu_1", "name": "Bash",
              "input": { "command": "echo hi" } }
        ] }
    });
    let snap_chunks = claude_event_to_chunks_with_state("thread_1", &snapshot, true, &mut state);
    // text 跳过 + tool_use 已发过 -> 整条快照不再产 ToolCall
    assert!(snap_chunks.is_empty());
}
