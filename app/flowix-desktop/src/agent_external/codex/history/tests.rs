use super::*;

#[test]
fn recognizes_codex_session_ids() {
    assert!(is_codex_session_id("019ed38f-e9e3-7b61-8be3-80a40788d6e3"));
    assert!(!is_codex_session_id("thread_1781665906"));
}

#[test]
fn recognizes_runtime_injected_user_messages() {
    assert!(is_hidden_codex_user_message(
        "<recommended_plugins>\nplugin list\n</recommended_plugins>"
    ));
    assert!(is_hidden_codex_user_message(
        "  \n<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>"
    ));
    assert!(!is_hidden_codex_user_message(
        "show <environment_context> examples"
    ));
    assert!(!is_hidden_codex_user_message("regular user prompt"));
}

#[test]
fn rejects_local_codex_thread_ids() {
    // �?claude 的修�?── "codex-local-agent-inst-..." 前缀直接拒掉,
    // 避免�?��前�?占位符当 Codex CLI session id�?
    assert!(!is_codex_session_id(
        "codex-local-agent-inst-1783828675847-3"
    ));
    assert!(!is_codex_session_id(""));
}

#[test]
fn extracts_session_id_from_rollout_filename() {
    let path =
        PathBuf::from("rollout-2026-06-17T11-11-24-019ed38f-e9e3-7b61-8be3-80a40788d6e3.jsonl");
    assert_eq!(
        session_id_from_filename(&path).as_deref(),
        Some("019ed38f-e9e3-7b61-8be3-80a40788d6e3")
    );
}

#[test]
fn reads_only_current_turn_tool_response_items_for_stream_reconciliation() {
    let text = [
        serde_json::json!({
            "timestamp": "2026-07-25T09:31:39.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "call_id": "old_call",
                "name": "exec",
                "input": "text('old')"
            }
        }),
        serde_json::json!({
            "timestamp": "2026-07-25T09:31:41.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "hello" }]
            }
        }),
        serde_json::json!({
            "timestamp": "2026-07-25T09:31:42.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "call_id": "current_call",
                "name": "exec",
                "input": "text('current')"
            }
        }),
        serde_json::json!({
            "timestamp": "2026-07-25T09:31:43.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "current_call",
                "output": "done"
            }
        }),
    ]
    .into_iter()
    .map(|value| value.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    let started_at = parse_timestamp_millis("2026-07-25T09:31:40.000Z").unwrap();

    let events = parse_rollout_tool_response_items_since(&text, started_at);

    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0]
            .pointer("/payload/call_id")
            .and_then(Value::as_str),
        Some("current_call")
    );
    assert_eq!(
        events[1].pointer("/payload/type").and_then(Value::as_str),
        Some("custom_tool_call_output")
    );
    assert_eq!(events[0].source_sequence, 2);
    assert_eq!(
        events[0].source_timestamp,
        parse_timestamp_millis("2026-07-25T09:31:42.000Z")
    );
}

#[test]
fn maps_response_item_function_call_to_tool_message() {
    let payload = serde_json::json!({
        "type": "function_call",
        "name": "shell_command",
        "arguments": "{\"command\":\"echo congratulations\"}",
        "call_id": "call_1"
    });
    let message = response_item_to_chat_message("session_1", 3, "2026-06-17T03:11:36Z", &payload)
        .expect("tool message");
    assert_eq!(message.role, "tool");
    assert_eq!(message.tool_call_id.as_deref(), Some("call_1"));
    assert_eq!(message.tool_name.as_deref(), Some("shell_command"));
    assert_eq!(
        message.tool_input.as_ref().and_then(|v| v.get("command")),
        Some(&serde_json::json!("echo congratulations"))
    );
    assert_eq!(message.is_loading, Some(true));
}

#[test]
fn restores_custom_tool_call_and_content_block_output_as_one_tool_row() {
    // Shape captured from ~/.codex/sessions/2026/07/18 rollouts.
    let session = concat!(
            "{\"timestamp\":\"2026-07-18T08:00:00Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"call_id\":\"call_exec_1\",\"name\":\"exec\",\"input\":\"const r = await tools.exec_command({\\\"cmd\\\":\\\"pwd\\\"}); text(r.output);\"}}\n",
            "{\"timestamp\":\"2026-07-18T08:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"call_exec_1\",\"output\":[{\"type\":\"input_text\",\"text\":\"Script completed\\n\"},{\"type\":\"input_text\",\"text\":\"/tmp/project\\n\"}]}}\n"
        );

    let messages = parse_codex_session_messages("session_1", session);

    assert_eq!(messages.len(), 1);
    let message = &messages[0];
    assert_eq!(message.role, "tool");
    assert_eq!(message.tool_call_id.as_deref(), Some("call_exec_1"));
    assert_eq!(message.tool_name.as_deref(), Some("exec_command"));
    assert_eq!(
        message.tool_input,
        Some(serde_json::json!(
            "const r = await tools.exec_command({\"cmd\":\"pwd\"}); text(r.output);"
        ))
    );
    assert_eq!(message.is_loading, Some(false));
    let data: Value = serde_json::from_str(&message.content).expect("tool data json");
    assert_eq!(
        data.get("output").and_then(Value::as_str),
        Some("Script completed\n/tmp/project\n")
    );
}

#[test]
fn restores_registered_and_unknown_complete_tool_records() {
    let session = concat!(
            "{\"timestamp\":\"2026-07-18T08:00:00Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"mcp_tool_call\",\"id\":\"mcp_1\",\"tool_name\":\"read_document\",\"arguments\":{\"id\":\"doc_1\"},\"result\":{\"content\":\"body\"}}}\n",
            "{\"timestamp\":\"2026-07-18T08:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"future_connector_call\",\"call_id\":\"future_1\",\"name\":\"future_connector\",\"arguments\":{\"query\":\"hello\"}}}\n",
            "{\"timestamp\":\"2026-07-18T08:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"future_connector_output\",\"call_id\":\"future_1\",\"output\":\"future result\"}}\n",
            "{\"timestamp\":\"2026-07-18T08:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"thread_settings_applied\",\"model\":\"gpt-5\"}}\n"
        );

    let messages = parse_codex_session_messages("session_1", session);

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].tool_call_id.as_deref(), Some("mcp_1"));
    assert_eq!(messages[0].tool_name.as_deref(), Some("mcp_tool_call"));
    assert_eq!(
        messages[0]
            .tool_input
            .as_ref()
            .and_then(|input| input.get("tool"))
            .and_then(Value::as_str),
        Some("read_document")
    );
    assert_eq!(messages[0].is_loading, Some(false));
    assert_eq!(messages[1].tool_call_id.as_deref(), Some("future_1"));
    assert_eq!(messages[1].tool_name.as_deref(), Some("future_connector"));
    assert_eq!(messages[1].is_loading, Some(false));
    assert!(messages[1].content.contains("future result"));
}

#[test]
fn restores_event_msg_mcp_and_file_change_tools() {
    let session = concat!(
            "{\"timestamp\":\"2026-07-18T08:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"mcp_tool_call_end\",\"call_id\":\"mcp_1\",\"invocation\":{\"server\":\"codex\",\"tool\":\"list_mcp_resources\",\"arguments\":{}},\"result\":{\"Ok\":{\"content\":[]}}}}\n",
            "{\"timestamp\":\"2026-07-18T08:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"patch_apply_end\",\"call_id\":\"patch_1\",\"success\":true,\"changes\":{\"/tmp/probe.svg\":{\"type\":\"add\"}}}}\n"
        );
    let messages = parse_codex_session_messages("session_1", session);

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].tool_name.as_deref(), Some("mcp_tool_call"));
    assert_eq!(
        messages[0]
            .tool_input
            .as_ref()
            .and_then(|input| input.get("tool"))
            .and_then(Value::as_str),
        Some("list_mcp_resources")
    );
    assert_eq!(messages[1].tool_name.as_deref(), Some("file_change"));
    assert!(messages[1]
        .tool_input
        .as_ref()
        .and_then(|input| input.get("changes"))
        .and_then(|changes| changes.get("/tmp/probe.svg"))
        .is_some());
}

#[test]
fn maps_response_item_web_search_call_to_tool_message() {
    let payload = serde_json::json!({
        "type": "web_search_call",
        "id": "ws_1",
        "action": {
            "query": [{"q": "Flowix Codex web search history"}]
        },
        "status": "completed"
    });
    let message = response_item_to_chat_message("session_1", 3, "2026-06-17T03:11:36Z", &payload)
        .expect("web search tool message");
    assert_eq!(message.role, "tool");
    assert_eq!(message.tool_call_id.as_deref(), Some("ws_1"));
    assert_eq!(message.tool_name.as_deref(), Some("web_search"));
    assert_eq!(
        message
            .tool_input
            .as_ref()
            .and_then(|v| v.get("action"))
            .and_then(|v| v.get("query")),
        Some(&serde_json::json!([{ "q": "Flowix Codex web search history" }]))
    );
    assert_eq!(message.is_loading, Some(false));
}

#[test]
fn truncates_large_function_call_output_for_history_messages() {
    let large_output = "x".repeat(MAX_HISTORY_TOOL_OUTPUT_CHARS + 10);
    let payload = serde_json::json!({
        "type": "function_call_output",
        "call_id": "call_1",
        "output": large_output,
    });

    let message = response_item_to_chat_message("session_1", 4, "2026-06-17T03:11:36Z", &payload)
        .expect("tool result message");
    let tool_data = message.tool_data.as_deref().expect("tool data");
    let data: Value = serde_json::from_str(tool_data).expect("tool data json");

    assert_eq!(message.role, "tool");
    assert_eq!(message.tool_call_id.as_deref(), Some("call_1"));
    assert_eq!(data.get("output_chars").and_then(Value::as_u64), Some(4106));
    assert_eq!(
        data.get("output_truncated").and_then(Value::as_bool),
        Some(true)
    );
    assert!(data
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .ends_with("...[truncated]"));
}

#[test]
fn paginates_codex_messages_with_virtual_sequence() {
    let messages = (0..25)
        .map(|idx| {
            base_message(
                format!("message-{idx}"),
                "assistant",
                format!("message {idx}"),
                "2026-06-17T03:11:36Z",
            )
        })
        .collect::<Vec<_>>();

    let first = paginate_codex_messages(messages.clone(), None, 10);
    assert_eq!(first.messages.len(), 10);
    assert_eq!(first.messages[0].id, "message-15");
    assert_eq!(first.oldest_sequence, Some(16));
    assert!(first.has_more);

    let second = paginate_codex_messages(messages, first.oldest_sequence, 10);
    assert_eq!(second.messages.len(), 10);
    assert_eq!(second.messages[0].id, "message-5");
    assert_eq!(second.oldest_sequence, Some(6));
    assert!(second.has_more);
}

#[test]
fn preserves_identical_user_prompts_from_different_turns() {
    let session = [
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "task_started", "turn_id": "turn-1" }
        }),
        serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "same question" }],
                "internal_chat_message_metadata_passthrough": { "turn_id": "turn-1" }
            }
        }),
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "same question" }
        }),
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "task_started", "turn_id": "turn-2" }
        }),
        serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "same question" }],
                "internal_chat_message_metadata_passthrough": { "turn_id": "turn-2" }
            }
        }),
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "same question" }
        }),
    ]
    .into_iter()
    .map(|value| value.to_string())
    .collect::<Vec<_>>()
    .join("\n");

    let messages = parse_codex_session_messages("session-1", &session);
    assert_eq!(messages.len(), 2);
    assert!(messages
        .iter()
        .all(|message| message.role == "user" && message.content == "same question"));
}

#[test]
fn paginates_codex_history_by_complete_user_turns() {
    let messages = vec![
        base_message("u1".into(), "user", "question 1".into(), "1"),
        base_message("a1".into(), "assistant", "answer 1".into(), "2"),
        base_message("u2".into(), "user", "question 2".into(), "3"),
        base_message("r2".into(), "reasoning", "thought 2".into(), "4"),
        base_message("a2".into(), "assistant", "answer 2".into(), "5"),
        base_message("u3".into(), "user", "question 3".into(), "6"),
        base_message("a3".into(), "assistant", "answer 3".into(), "7"),
    ];

    let latest = paginate_codex_messages(messages.clone(), None, 1);
    assert_eq!(
        latest
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["u3", "a3"]
    );
    assert!(latest.has_more);

    let older = paginate_codex_messages(messages, latest.oldest_sequence, 1);
    assert_eq!(
        older
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["u2", "r2", "a2"]
    );
    assert!(older.has_more);
}

#[test]
fn close_orphan_codex_tool_calls_closes_only_unmatched_calls() {
    let mut messages = vec![
        // function_call(call_id=X) 鈥?has a matching output below.
        tool_call_msg("X", "Read", true),
        // function_call(call_id=Y) 鈥?killed before tool_result was written.
        tool_call_msg("Y", "Bash", true),
        // function_call_output for X (already merged with the row above).
        tool_result_msg("X", "ok"),
    ];

    close_orphan_codex_tool_calls(&mut messages);

    let by_call: std::collections::HashMap<&str, &ChatMessage> = messages
        .iter()
        .filter_map(|m| m.tool_call_id.as_deref().map(|id| (id, m)))
        .collect();
    // X: matched 鈫?left at is_loading=false (because the output row has it).
    assert_eq!(by_call["X"].is_loading, Some(false));
    // Y: unmatched 鈫?forced to false.
    assert_eq!(by_call["Y"].is_loading, Some(false));
}

#[test]
fn close_orphan_codex_tool_calls_leaves_non_tool_rows_alone() {
    // User rows and any other non-tool rows must not be touched by
    // the orphan sweep; only role=tool rows with is_loading=true and
    // unmatched call_id are fair game.
    let mut messages = vec![
        user_msg("hello"),
        tool_call_msg("Z", "Read", false), // already merged with output below
        tool_result_msg("Z", "loaded"),
    ];

    close_orphan_codex_tool_calls(&mut messages);

    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].is_loading, None);
    // The merge layer is what flips a matched function_call to
    // is_loading=false; the orphan sweep correctly leaves it alone.
    assert_eq!(messages[1].is_loading, Some(false));
    assert_eq!(messages[2].is_loading, Some(false));
}

fn tool_call_msg(call_id: &str, name: &str, loading: bool) -> ChatMessage {
    let mut m = base_message(
        format!("tool-{call_id}"),
        "tool",
        String::new(),
        "2026-06-17T03:11:36Z",
    );
    m.tool_call_id = Some(call_id.to_string());
    m.tool_name = Some(name.to_string());
    m.is_loading = Some(loading);
    m.tool_input = Some(serde_json::json!({}));
    m
}

fn tool_result_msg(call_id: &str, output: &str) -> ChatMessage {
    let mut m = base_message(
        format!("tool-result-{call_id}"),
        "tool",
        output.to_string(),
        "2026-06-17T03:11:37Z",
    );
    m.tool_call_id = Some(call_id.to_string());
    m.tool_name = Some("tool_result".to_string());
    m.tool_data = Some(output.to_string());
    m.is_loading = Some(false);
    m
}

fn user_msg(text: &str) -> ChatMessage {
    base_message(
        "user-msg".to_string(),
        "user",
        text.to_string(),
        "2026-06-17T03:11:35Z",
    )
}

/// Codex rollout session_meta 事件�?`payload.cwd`. 验证
/// `codex_session_cwd_in` 能从该字段�?出真�?── 后�? cwd 兜底�?    /// �?IPC 入参空时, 用这�?��救�?"重启�?resume cwd 缺失"�?
#[test]
fn codex_session_cwd_reads_payload_cwd() {
    let tmp = codex_session_cwd_tempdir();
    let sessions_dir = tmp.join(".codex").join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");
    let sid = "019ed38f-7c41-7b32-9c11-80a40788d6e3";
    let path = sessions_dir.join(format!("rollout-2026-07-12T00-00-00-{sid}.jsonl"));
    std::fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"2026-07-12T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{sid}\",\"cwd\":\"{tmp}\"}}}}\n",
                tmp = tmp.display(),
                sid = sid,
            ),
        )
        .expect("write rollout jsonl");

    // 不依�?dirs::home_dir / HOME env. 直接�?home.
    let cwd = codex_session_cwd_in(&tmp, sid).expect("read cwd");
    let resolved = cwd.expect("cwd should be present");
    assert_eq!(resolved, tmp);
}

/// 字�?缺失时返�?None ── 不允许悄悄兜底到 "."
#[test]
fn codex_session_cwd_returns_none_when_missing() {
    let tmp = codex_session_cwd_tempdir();
    let sessions_dir = tmp.join(".codex").join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");
    let sid = "019ed38f-7c41-7b32-9c11-80a40788d6e4";
    let path = sessions_dir.join(format!("rollout-2026-07-12T00-00-00-{sid}.jsonl"));
    std::fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"2026-07-12T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{sid}\"}}}}\n",
                sid = sid
            ),
        )
        .expect("write rollout jsonl");

    let cwd = codex_session_cwd_in(&tmp, sid).expect("read cwd");
    assert!(cwd.is_none());
}

fn codex_session_cwd_tempdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "codex-history-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("tempdir");
    dir
}
