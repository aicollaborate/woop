use super::*;

#[test]
fn maps_codex_command_execution_to_lightweight_tool_chunks() {
    let started = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "function_call",
            "call_id": "call_0",
            "name": "command_execution",
            "arguments": {
                "command": "powershell -Command 'echo congratulations'"
            }
        }
    });
    let completed = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "function_call_output",
            "call_id": "call_0",
            "name": "command_execution",
            "output": "congratulations\r\n"
        }
    });

    let start_chunks = codex_event_to_chunks("thread_1", &started);
    assert!(matches!(
        start_chunks.as_slice(),
        [AgentChunk::ToolCall { name, input, .. }]
            if name == "command_execution"
                && input.get("command").and_then(Value::as_str)
                    == Some("powershell -Command 'echo congratulations'")
    ));

    let complete_chunks = codex_event_to_chunks("thread_1", &completed);
    assert!(matches!(
        complete_chunks.as_slice(),
        [AgentChunk::ToolResult { name, result, .. }]
            if name == "command_execution"
                && result.get("output_preview").and_then(Value::as_str)
                    == Some("congratulations\r\n")
    ));
}

#[test]
fn truncates_large_codex_command_output_in_ui_chunks() {
    let large_output = "x".repeat(super::MAX_UI_OUTPUT_PREVIEW_CHARS + 10);
    let completed = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "function_call_output",
            "call_id": "call_large",
            "name": "command_execution",
            "output": large_output
        }
    });

    let chunks = codex_event_to_chunks("thread_1", &completed);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { result, .. }]
            if result.get("output_truncated").and_then(Value::as_bool) == Some(true)
                && result.get("output_preview")
                    .and_then(Value::as_str)
                    .map(|text| text.ends_with("...[truncated]"))
                    == Some(true)
    ));
}

#[test]
fn preserves_names_for_current_codex_function_tools() {
    for name in [
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource",
        "get_goal",
        "create_goal",
        "update_goal",
        "apply_patch",
        "view_image",
        "exec_command",
        "update_plan",
    ] {
        let value = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "call_id": format!("call_{name}"),
                "name": name,
                "arguments": "{}"
            }
        });
        assert!(matches!(
            codex_event_to_chunks("thread_1", &value).as_slice(),
            [AgentChunk::ToolCall { name: actual, .. }] if actual == name
        ));
    }
}

#[test]
fn preserves_structured_and_failure_outputs_for_function_tools() {
    let cases = [
        (
            "list_mcp_resources",
            serde_json::json!({
                "resources": [{
                    "server": "docs",
                    "uri": "resource://guide",
                    "metadata": { "nested": { "depth": 3 } }
                }]
            })
            .to_string(),
        ),
        ("list_mcp_resource_templates", "[]".to_string()),
        (
            "get_goal",
            serde_json::json!({ "status": "none" }).to_string(),
        ),
        ("view_image", "SVG preview is not supported".to_string()),
        (
            "view_image",
            serde_json::json!({
                "detail": "high",
                "image_url": "data:image/png;base64,preview"
            })
            .to_string(),
        ),
    ];

    for (index, (name, output)) in cases.into_iter().enumerate() {
        let value = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": format!("call_{index}"),
                "name": name,
                "output": output
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { result, .. }]
                if result.is_object() || result.is_array()
        ));
    }
}

#[test]
fn maps_codex_agent_message_to_text_chunk() {
    let value = serde_json::json!({
        "type": "event_msg",
        "payload": {
            "type": "agent_message",
            "message": "`echo congratulations` output: congratulations"
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Text { text, .. }] if text.contains("congratulations")
    ));
}

#[test]
fn maps_new_codex_item_completed_message_to_text_chunk() {
    let value = serde_json::json!({
        "type": "item.completed",
        "item": {
            "type": "agent_message",
            "text": "FLOWIX_CODEX_EVENT_DIAGNOSTIC_OK"
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Text { text, .. }] if text.contains("FLOWIX_CODEX_EVENT_DIAGNOSTIC_OK")
    ));
}

#[test]
fn maps_new_codex_item_started_command_execution_to_tool_call() {
    let value = serde_json::json!({
        "type": "item.started",
        "item": {
            "id": "item_1",
            "type": "command_execution",
            "command": "bash -lc ls",
            "status": "in_progress"
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolCall { id, name, input, .. }]
            if id == "item_1"
                && name == "command_execution"
                && input.get("command").and_then(Value::as_str) == Some("bash -lc ls")
    ));
}

#[test]
fn maps_codex_todo_list_lifecycle_to_update_plan_chunks() {
    let started = serde_json::json!({
        "type": "item.started",
        "item": {
            "id": "item_plan",
            "type": "todo_list",
            "items": [
                { "text": "Inspect streaming events", "completed": false },
                { "title": "Compare persisted history", "state": "running" }
            ]
        }
    });
    let updated = serde_json::json!({
        "type": "item.updated",
        "item": {
            "id": "item_plan",
            "type": "todo_list",
            "todos": [
                { "content": "Inspect streaming events", "status": "done" },
                { "label": "Compare persisted history", "status": "in-progress" }
            ]
        }
    });
    let completed = serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "item_plan",
            "type": "todo_list",
            "plan": [
                { "step": "Inspect streaming events", "status": "completed" },
                { "step": "Compare persisted history", "completed": true }
            ]
        }
    });

    let started_chunks = codex_event_to_chunks("thread_1", &started);
    assert!(matches!(
        started_chunks.as_slice(),
        [AgentChunk::ToolCall { id, name, input, .. }]
            if id == "item_plan"
                && name == "update_plan"
                && input.pointer("/plan/0/status").and_then(Value::as_str)
                    == Some("pending")
                && input.pointer("/plan/1/status").and_then(Value::as_str)
                    == Some("in_progress")
    ));

    let updated_chunks = codex_event_to_chunks("thread_1", &updated);
    assert!(matches!(
        updated_chunks.as_slice(),
        [
            AgentChunk::ToolCall { id, name, input, .. },
            AgentChunk::ToolResult { id: result_id, name: result_name, .. }
        ]
            if id == "item_plan"
                && result_id == id
                && name == "update_plan"
                && result_name == name
                && input.pointer("/plan/0/status").and_then(Value::as_str)
                    == Some("completed")
                && input.pointer("/plan/1/status").and_then(Value::as_str)
                    == Some("in_progress")
    ));

    let completed_chunks = codex_event_to_chunks("thread_1", &completed);
    assert!(matches!(
        completed_chunks.as_slice(),
        [
            AgentChunk::ToolCall { input, .. },
            AgentChunk::ToolResult { .. }
        ]
            if input.pointer("/plan/0/step").and_then(Value::as_str)
                    == Some("Inspect streaming events")
                && input.pointer("/plan/1/status").and_then(Value::as_str)
                    == Some("completed")
    ));
}

#[test]
fn maps_official_command_aggregated_output_to_tool_result() {
    let value = serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "item_1",
            "type": "command_execution",
            "command": "/bin/zsh -lc pwd",
            "aggregated_output": "/tmp/project\n",
            "exit_code": 0,
            "status": "completed"
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [
            AgentChunk::ToolCall { id: call_id, name: call_name, input, .. },
            AgentChunk::ToolResult { id, name, result, .. }
        ]
            if id == "item_1"
                && call_id == id
                && name == "command_execution"
                && call_name == name
                && input.get("command").and_then(Value::as_str)
                    == Some("/bin/zsh -lc pwd")
                && result.get("output_preview").and_then(Value::as_str)
                    == Some("/tmp/project\n")
    ));
}

#[test]
fn flattens_custom_tool_content_blocks_for_live_tool_result() {
    let value = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "custom_tool_call_output",
            "call_id": "call_exec_1",
            "output": [
                { "type": "input_text", "text": "Script completed\n" },
                { "type": "input_text", "text": "/tmp/project\n" }
            ]
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolResult { id, result, .. }]
            if id == "call_exec_1"
                && result.get("output_preview").and_then(Value::as_str)
                    == Some("Script completed\n/tmp/project\n")
    ));
}

#[test]
fn maps_registered_mcp_lifecycle_events() {
    let started = serde_json::json!({
        "type": "item.started",
        "item": {
            "id": "mcp_1",
            "type": "mcp_tool_call",
            "tool_name": "read_document",
            "arguments": { "id": "doc_1" },
            "status": "in_progress"
        }
    });
    let completed = serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "mcp_1",
            "type": "mcp_tool_call",
            "tool_name": "read_document",
            "arguments": { "id": "doc_1" },
            "result": { "content": "document body" },
            "status": "completed"
        }
    });

    assert!(matches!(
        codex_event_to_chunks("thread_1", &started).as_slice(),
        [AgentChunk::ToolCall { id, name, input, .. }]
            if id == "mcp_1"
                && name == "mcp_tool_call"
                && input.get("tool").and_then(Value::as_str) == Some("read_document")
    ));
    assert!(matches!(
        codex_event_to_chunks("thread_1", &completed).as_slice(),
        [
            AgentChunk::ToolCall { id, name, input, .. },
            AgentChunk::ToolResult { id: result_id, name: result_name, .. }
        ]
            if id == "mcp_1"
                && result_id == id
                && name == "mcp_tool_call"
                && result_name == name
                && input.get("tool").and_then(Value::as_str) == Some("read_document")
    ));
}

#[test]
fn maps_real_event_msg_tool_end_shapes_with_specific_inputs() {
    let mcp = serde_json::json!({
        "type": "event_msg",
        "payload": {
            "type": "mcp_tool_call_end",
            "call_id": "exec-mcp-1",
            "invocation": {
                "server": "codex",
                "tool": "list_mcp_resources",
                "arguments": {}
            },
            "result": { "Ok": { "content": [] } }
        }
    });
    let mcp_chunks = codex_event_to_chunks("thread_1", &mcp);
    assert!(matches!(
        mcp_chunks.as_slice(),
        [AgentChunk::ToolCall { name, input, .. }, AgentChunk::ToolResult { .. }]
            if name == "mcp_tool_call"
                && input.get("tool").and_then(Value::as_str)
                    == Some("list_mcp_resources")
                && input.get("server").and_then(Value::as_str) == Some("codex")
    ));

    let patch = serde_json::json!({
        "type": "event_msg",
        "payload": {
            "type": "patch_apply_end",
            "call_id": "patch-1",
            "success": true,
            "changes": {
                "/tmp/probe.svg": { "type": "add" }
            }
        }
    });
    let patch_chunks = codex_event_to_chunks("thread_1", &patch);
    assert!(matches!(
        patch_chunks.as_slice(),
        [AgentChunk::ToolCall { name, input, .. }, AgentChunk::ToolResult { .. }]
            if name == "file_change"
                && input.get("changes")
                    .and_then(|changes| changes.get("/tmp/probe.svg"))
                    .is_some()
    ));
}

#[test]
fn unknown_event_msg_tool_end_uses_complete_fallback() {
    let value = serde_json::json!({
        "type": "event_msg",
        "payload": {
            "type": "future_tool_end",
            "call_id": "future-1",
            "name": "future_connector",
            "arguments": { "query": "hello" },
            "result": { "content": "world" }
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolCall { name, .. }, AgentChunk::ToolResult { .. }]
            if name == "future_connector"
    ));
}

#[test]
fn maps_real_codex_file_change_lifecycle_shape() {
    let started = serde_json::json!({
        "type": "item.started",
        "item": {
            "id": "item_1",
            "type": "file_change",
            "changes": [{ "path": "/tmp/probe.txt", "kind": "add" }],
            "status": "in_progress"
        }
    });
    let completed = serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "item_1",
            "type": "file_change",
            "changes": [{ "path": "/tmp/probe.txt", "kind": "add" }],
            "status": "completed"
        }
    });

    assert!(matches!(
        codex_event_to_chunks("thread_1", &started).as_slice(),
        [AgentChunk::ToolCall { id, name, input, .. }]
            if id == "item_1"
                && name == "file_change"
                && input.get("changes").and_then(Value::as_array).is_some()
    ));
    assert!(matches!(
        codex_event_to_chunks("thread_1", &completed).as_slice(),
        [
            AgentChunk::ToolCall { id, name, input, .. },
            AgentChunk::ToolResult { id: result_id, name: result_name, result, .. }
        ]
            if id == "item_1"
                && result_id == id
                && name == "file_change"
                && result_name == name
                && input.get("changes").and_then(Value::as_array).is_some()
                && result.as_array().is_some()
    ));
}

#[test]
fn unknown_tool_shaped_response_item_gets_generic_complete_chunks() {
    let value = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "future_connector_call",
            "call_id": "future_1",
            "name": "future_connector",
            "arguments": { "query": "hello" },
            "result": { "status": "ok" }
        }
    });

    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [
            AgentChunk::ToolCall { id: call_id, name: call_name, .. },
            AgentChunk::ToolResult { id: result_id, name: result_name, .. }
        ] if call_id == "future_1"
            && result_id == "future_1"
            && call_name == "future_connector"
            && result_name == "future_connector"
    ));
}

#[test]
fn unknown_non_tool_item_stays_hidden() {
    let value = serde_json::json!({
        "type": "item.completed",
        "item": {
            "type": "thread_settings_applied",
            "model": "gpt-5"
        }
    });
    assert!(codex_event_to_chunks("thread_1", &value).is_empty());
}

#[test]
fn maps_new_codex_turn_completed_usage_to_usage_chunk() {
    let value = serde_json::json!({
        "type": "turn.completed",
        "usage": {
            "input_tokens": 24763,
            "cached_input_tokens": 24448,
            "output_tokens": 122,
            "reasoning_output_tokens": 0
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Usage {
            usage: Some(crate::agent_types::UsageInfo {
                input_tokens: Some(24763),
                cached_input_tokens: Some(24448),
                output_tokens: Some(122),
                reasoning_output_tokens: Some(0),
                total_tokens: Some(24885),
                ..
            }),
            ..
        }]
    ));
}

#[test]
fn maps_official_codex_jsonl_fixture_to_ui_chunks() {
    let fixture = [
        r#"{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}"#,
        r#"{"type":"turn.started"}"#,
        r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}"#,
        r#"{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}"#,
    ];
    let chunks: Vec<AgentChunk> = fixture
        .iter()
        .flat_map(|line| {
            let value: Value = serde_json::from_str(line).expect("fixture line is valid JSON");
            codex_event_to_chunks("thread_1", &value)
        })
        .collect();

    assert_eq!(chunks.len(), 3);
    assert!(matches!(
        &chunks[0],
        AgentChunk::ToolCall { id, name, input, .. }
            if id == "item_1"
                && name == "command_execution"
                && input.get("command").and_then(Value::as_str) == Some("bash -lc ls")
    ));
    assert!(matches!(
        &chunks[1],
        AgentChunk::Text { text, .. }
            if text == "Repo contains docs, sdk, and examples directories."
    ));
    assert!(matches!(
        &chunks[2],
        AgentChunk::Usage {
            usage: Some(crate::agent_types::UsageInfo {
                input_tokens: Some(24763),
                cached_input_tokens: Some(24448),
                output_tokens: Some(122),
                reasoning_output_tokens: Some(0),
                total_tokens: Some(24885),
                ..
            }),
            ..
        }
    ));
}

#[test]
fn maps_codex_stdout_contract_fixture_to_expected_chunks() {
    let chunks: Vec<AgentChunk> = include_str!("../../fixtures/codex_stdout_contract.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .flat_map(|line| {
            let value: Value = serde_json::from_str(line).expect("fixture line is valid JSON");
            codex_event_to_chunks("thread_contract", &value)
        })
        .collect();

    assert_eq!(chunks.len(), 7);
    assert!(matches!(
        &chunks[0],
        AgentChunk::ToolCall { id, name, input, .. }
            if id == "item_cmd_1"
                && name == "command_execution"
                && input.get("command").and_then(Value::as_str) == Some("bash -lc pwd")
    ));
    assert!(matches!(
        &chunks[1],
        AgentChunk::ToolCall { id, name, input, .. }
            if id == "item_cmd_1"
                && name == "command_execution"
                && input.get("command").and_then(Value::as_str) == Some("bash -lc pwd")
    ));
    assert!(matches!(
        &chunks[2],
        AgentChunk::ToolResult { id, name, result, .. }
            if id == "item_cmd_1"
                && name == "command_execution"
                && result.get("output_preview").and_then(Value::as_str)
                    == Some("/tmp/flowix\n")
    ));
    assert!(matches!(
        &chunks[3],
        AgentChunk::Reasoning { text, .. }
            if text == "Need inspect workspace before answering."
    ));
    assert!(matches!(
        &chunks[4],
        AgentChunk::Text { text, .. } if text == "The workspace is /tmp/flowix."
    ));
    assert!(matches!(
        &chunks[5],
        AgentChunk::Usage {
            usage: Some(crate::agent_types::UsageInfo {
                input_tokens: Some(120),
                cached_input_tokens: Some(40),
                output_tokens: Some(16),
                reasoning_output_tokens: Some(4),
                total_tokens: Some(140),
                ..
            }),
            ..
        }
    ));
    assert!(matches!(
        &chunks[6],
        AgentChunk::Error { message, .. } if message == "fatal transport error"
    ));
}

#[test]
fn skips_transient_codex_reconnect_errors() {
    let error = serde_json::json!({
        "type": "error",
        "message": "Reconnecting..."
    });
    let failed = serde_json::json!({
        "type": "turn.failed",
        "error": {
            "message": "stream disconnected before completion; retrying"
        }
    });

    assert!(is_transient_codex_reconnect_event(&error));
    assert!(codex_event_to_chunks("thread_1", &error).is_empty());
    assert!(is_transient_codex_reconnect_event(&failed));
    assert!(codex_event_to_chunks("thread_1", &failed).is_empty());
}

#[test]
fn maps_new_codex_error_events_to_error_chunks() {
    let error = serde_json::json!({
        "type": "error",
        "message": "fatal transport error"
    });
    let failed = serde_json::json!({
        "type": "turn.failed",
        "error": {
            "message": "stream disconnected before completion"
        }
    });

    let error_chunks = codex_event_to_chunks("thread_1", &error);
    assert!(matches!(
        error_chunks.as_slice(),
        [AgentChunk::Error { message, .. }] if message.contains("fatal transport")
    ));

    let failed_chunks = codex_event_to_chunks("thread_1", &failed);
    assert!(matches!(
        failed_chunks.as_slice(),
        [AgentChunk::Error { message, .. }] if message.contains("stream disconnected")
    ));
}

#[test]
fn maps_codex_token_count_to_usage_chunk() {
    let value = serde_json::json!({
        "type": "event_msg",
        "timestamp": 1_756_468_800,
        "payload": {
            "type": "token_count",
            "input_tokens": 100,
            "cached_input_tokens": 40,
            "output_tokens": 20,
            "reasoning_output_tokens": 5,
            "total_tokens": 125,
            "model_context_window": 400000,
            "codex_plan_type": "pro",
            "codex_used_percent": 22.0,
            "codex_resets_at": 1_756_555_200
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::Usage {
            usage: Some(crate::agent_types::UsageInfo {
                input_tokens: Some(100),
                cached_input_tokens: Some(40),
                output_tokens: Some(20),
                reasoning_output_tokens: Some(5),
                total_tokens: Some(125),
                model_context_window: Some(400000),
                ..
            }),
            status_info: Some(crate::agent_types::StatusInfo {
                codex_plan_type,
                codex_used_percent,
                codex_resets_at: Some(1_756_555_200),
                ..
            }),
            last_run_at: Some(1_756_468_800_000),
            ..
        }] if codex_plan_type.as_deref() == Some("pro")
            && codex_used_percent == &Some(22.0)
    ));
}

#[test]
fn skips_unlisted_codex_events() {
    let value = serde_json::json!({
        "type": "item.completed",
        "item": {
            "type": "unknown_item",
            "text": "legacy duplicate"
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(chunks.is_empty());
}

#[test]
fn maps_codex_web_search_call_to_web_search_tool_call() {
    let value = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "function_call",
            "call_id": "ws_1",
            "name": "web_search",
            "arguments": {
                "query": "Flowix Codex web search"
            }
        }
    });
    let chunks = codex_event_to_chunks("thread_1", &value);
    assert!(matches!(
        chunks.as_slice(),
        [AgentChunk::ToolCall { name, input, .. }]
            if name == "web_search"
                && input.get("query").and_then(Value::as_str) == Some("Flowix Codex web search")
    ));
}

#[test]
fn refreshes_web_search_card_with_completed_query_and_action() {
    let started = serde_json::json!({
        "type": "item.started",
        "item": {
            "id": "ws_1",
            "type": "web_search",
            "query": "",
            "action": { "type": "other" }
        }
    });
    let completed = serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "ws_1",
            "type": "web_search",
            "query": "Flowix Codex web search",
            "action": {
                "type": "search",
                "queries": ["Flowix Codex web search", "Flowix agent notes"]
            }
        }
    });

    assert!(matches!(
        codex_event_to_chunks("thread_1", &started).as_slice(),
        [AgentChunk::ToolCall { id, name, input, .. }]
            if id == "ws_1"
                && name == "web_search"
                && input.get("query").and_then(Value::as_str) == Some("")
                && input.pointer("/action/type").and_then(Value::as_str) == Some("other")
    ));
    assert!(matches!(
        codex_event_to_chunks("thread_1", &completed).as_slice(),
        [
            AgentChunk::ToolCall { id, name, input, .. },
            AgentChunk::ToolResult { id: result_id, name: result_name, .. }
        ]
            if id == "ws_1"
                && result_id == id
                && name == "web_search"
                && result_name == name
                && input.get("query").and_then(Value::as_str)
                    == Some("Flowix Codex web search")
                && input.pointer("/action/type").and_then(Value::as_str) == Some("search")
    ));
}

#[test]
fn preserves_codex_item_ids_as_message_metadata() {
    let assistant = serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "item_assistant_1",
            "type": "agent_message",
            "text": "done"
        }
    });
    let assistant_chunk = codex_event_to_chunks("thread_1", &assistant)
        .into_iter()
        .next()
        .expect("assistant chunk");
    let assistant_metadata = codex_chunk_metadata(&assistant, &assistant_chunk);
    assert_eq!(
        assistant_metadata.message_id.as_deref(),
        Some("assistant-item_assistant_1")
    );
    assert_eq!(assistant_metadata.message_phase, Some("completed"));
    assert_eq!(assistant_metadata.content_mode, Some("snapshot"));

    let tool = serde_json::json!({
        "type": "item.started",
        "item": {
            "id": "item_tool_1",
            "type": "command_execution",
            "command": "pwd"
        }
    });
    let tool_chunk = codex_event_to_chunks("thread_1", &tool)
        .into_iter()
        .next()
        .expect("tool chunk");
    let tool_metadata = codex_chunk_metadata(&tool, &tool_chunk);
    assert_eq!(
        tool_metadata.message_id.as_deref(),
        Some("tool-item_tool_1")
    );
    assert_eq!(tool_metadata.message_phase, Some("started"));
}
