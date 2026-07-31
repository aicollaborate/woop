use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::agent_flowix::AgentChunk;

pub const PROTOCOL_VERSION: u64 = 1;
pub const INITIALIZE_ID: u64 = 1;
pub const SESSION_ID: u64 = 2;
pub const PROMPT_ID: u64 = 3;

pub fn initialize_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": INITIALIZE_ID,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": {
                    "readTextFile": false,
                    "writeTextFile": false
                },
                "terminal": false
            },
            "clientInfo": {
                "name": "Flowix",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    })
}

pub fn new_session_request(cwd: &str, additional_directories: &[String]) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": SESSION_ID,
        "method": "session/new",
        "params": {
            "cwd": cwd,
            "additionalDirectories": additional_directories,
            "mcpServers": []
        }
    })
}

pub fn load_session_request(
    session_id: &str,
    cwd: &str,
    additional_directories: &[String],
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": SESSION_ID,
        "method": "session/load",
        "params": {
            "sessionId": session_id,
            "cwd": cwd,
            "additionalDirectories": additional_directories,
            "mcpServers": []
        }
    })
}

pub fn prompt_request(session_id: &str, prompt: &str, image_paths: &[String]) -> Value {
    let mut blocks = vec![json!({ "type": "text", "text": prompt })];
    blocks.extend(image_paths.iter().map(|path| {
        json!({
            "type": "resource_link",
            "uri": path_to_file_uri(path),
            "mimeType": image_mime_type(path),
            "name": std::path::Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("attachment")
        })
    }));
    json!({
        "jsonrpc": "2.0",
        "id": PROMPT_ID,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": blocks
        }
    })
}

pub fn cancel_notification(session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": { "sessionId": session_id }
    })
}

pub fn permission_response(
    request: &Value,
    permission_mode: Option<&str>,
    allowed_roots: &[PathBuf],
) -> Option<Value> {
    if request.get("method").and_then(Value::as_str) != Some("session/request_permission") {
        return None;
    }
    let id = request.get("id")?.clone();
    let options = request.pointer("/params/options")?.as_array()?;
    let allow = match permission_mode.map(str::trim) {
        Some("danger-full-access" | "yolo") => true,
        Some("workspace-write") => permission_targets_allowed_roots(request, allowed_roots),
        _ => false,
    };
    let wanted = if allow {
        ["allow_once", "allow_always"]
    } else {
        ["reject_once", "reject_always"]
    };
    let option_id = wanted.iter().find_map(|kind| {
        options.iter().find_map(|option| {
            (option.get("kind").and_then(Value::as_str) == Some(*kind))
                .then(|| option.get("optionId").cloned())
                .flatten()
        })
    });
    Some(match option_id {
        Some(option_id) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "outcome": {
                    "outcome": "selected",
                    "optionId": option_id
                }
            }
        }),
        None => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "outcome": { "outcome": "cancelled" } }
        }),
    })
}

pub fn unsupported_request_response(request: &Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let method = request.get("method")?.as_str()?;
    if method == "session/request_permission" {
        return None;
    }
    Some(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32601,
            "message": format!("Flowix ACP client does not implement {method}")
        }
    }))
}

pub fn response_result<'a>(message: &'a Value, id: u64) -> Option<Result<&'a Value, String>> {
    if message.get("id").and_then(Value::as_u64) != Some(id) {
        return None;
    }
    if let Some(error) = message.get("error") {
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        return Some(Err(text));
    }
    Some(Ok(message.get("result").unwrap_or(&Value::Null)))
}

pub fn session_id_from_result(result: &Value) -> Option<String> {
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
}

pub fn chunks_from_message(thread_id: &str, message: &Value) -> Vec<AgentChunk> {
    if message.get("method").and_then(Value::as_str) != Some("session/update") {
        return Vec::new();
    }
    let Some(update) = message.pointer("/params/update") else {
        return Vec::new();
    };
    match update.get("sessionUpdate").and_then(Value::as_str) {
        Some("agent_message_chunk") => content_text(update)
            .map(|text| AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text,
            })
            .into_iter()
            .collect(),
        Some("agent_thought_chunk") => content_text(update)
            .map(|text| AgentChunk::Reasoning {
                thread_id: thread_id.to_string(),
                text,
            })
            .into_iter()
            .collect(),
        Some("tool_call") => {
            let id = string_at(update, &["toolCallId", "id"]).unwrap_or_else(|| "tool".into());
            let name = string_at(update, &["kind", "title"]).unwrap_or_else(|| "tool".into());
            vec![AgentChunk::ToolCall {
                thread_id: thread_id.to_string(),
                id,
                name,
                input: update.get("rawInput").cloned().unwrap_or(Value::Null),
            }]
        }
        Some("tool_call_update") if is_terminal_tool_status(update) => {
            let id = string_at(update, &["toolCallId", "id"]).unwrap_or_else(|| "tool".into());
            let name = string_at(update, &["title", "kind"]).unwrap_or_else(|| "tool".into());
            let result = update
                .get("rawOutput")
                .cloned()
                .or_else(|| update.get("content").cloned())
                .unwrap_or_else(|| json!({ "status": update.get("status") }));
            let mut chunks = recovered_tool_input(update)
                .map(|input| AgentChunk::ToolCall {
                    thread_id: thread_id.to_string(),
                    id: id.clone(),
                    name: name.clone(),
                    input,
                })
                .into_iter()
                .collect::<Vec<_>>();
            chunks.push(AgentChunk::ToolResult {
                thread_id: thread_id.to_string(),
                id,
                name,
                result,
            });
            chunks
        }
        _ => Vec::new(),
    }
}

fn recovered_tool_input(update: &Value) -> Option<Value> {
    if let Some(raw_input) = update.get("rawInput").filter(|input| {
        input
            .as_object()
            .map(|object| !object.is_empty())
            .unwrap_or(!input.is_null())
    }) {
        return Some(raw_input.clone());
    }
    let path = update
        .pointer("/rawOutput/metadata/display/path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())?;
    Some(json!({ "filePath": path }))
}

fn content_text(update: &Value) -> Option<String> {
    update
        .pointer("/content/text")
        .or_else(|| update.get("text"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::to_string)
}

fn is_terminal_tool_status(update: &Value) -> bool {
    matches!(
        update.get("status").and_then(Value::as_str),
        Some("completed" | "failed" | "error")
    )
}

fn path_to_file_uri(path: &str) -> String {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    reqwest::Url::from_file_path(&absolute)
        .map(String::from)
        .unwrap_or_else(|_| absolute.to_string_lossy().to_string())
}

fn image_mime_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tif" | "tiff") => "image/tiff",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        _ => "image/png",
    }
}

fn permission_targets_allowed_roots(request: &Value, allowed_roots: &[PathBuf]) -> bool {
    let mut targets = Vec::new();
    if let Some(raw_input) = request.pointer("/params/toolCall/rawInput") {
        collect_permission_paths(raw_input, &mut targets);
    }
    if targets.is_empty() {
        if let Some(title) = request
            .pointer("/params/toolCall/title")
            .and_then(Value::as_str)
        {
            let candidate = PathBuf::from(title);
            if candidate.is_absolute() {
                targets.push(candidate);
            }
        }
    }
    !targets.is_empty()
        && targets.iter().all(|target| {
            allowed_roots
                .iter()
                .any(|root| path_is_within(target, root))
        })
}

fn collect_permission_paths(value: &Value, targets: &mut Vec<PathBuf>) {
    let Some(object) = value.as_object() else {
        return;
    };
    for key in [
        "parentDir",
        "filePath",
        "filepath",
        "path",
        "cwd",
        "workdir",
    ] {
        if let Some(path) = object.get(key).and_then(Value::as_str) {
            let candidate = PathBuf::from(path);
            if candidate.is_absolute() {
                targets.push(candidate);
            }
        }
    }
    if let Some(directories) = object.get("directories").and_then(Value::as_array) {
        targets.extend(
            directories
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute()),
        );
    }
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    let path = normalized_path(path);
    let root = normalized_path(root);
    path == root || path.starts_with(root)
}

fn normalized_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_streamed_agent_text() {
        let value = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "ses_1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "hello" }
                }
            }
        });
        assert!(matches!(
            chunks_from_message("thread", &value).as_slice(),
            [AgentChunk::Text { text, .. }] if text == "hello"
        ));
    }

    #[test]
    fn maps_opencode_tool_kind_and_camel_case_file_path() {
        let value = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "ses_1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call_1",
                    "title": "Notes\\presentation\\Agent 评测框架.md",
                    "kind": "read",
                    "status": "pending",
                    "rawInput": {
                        "filePath": "D:/Notes/presentation/Agent 评测框架.md"
                    }
                }
            }
        });

        assert!(matches!(
            chunks_from_message("thread", &value).as_slice(),
            [AgentChunk::ToolCall { id, name, input, .. }]
                if id == "call_1"
                    && name == "read"
                    && input.get("filePath").and_then(Value::as_str)
                        == Some("D:/Notes/presentation/Agent 评测框架.md")
        ));
    }

    #[test]
    fn recovers_read_path_from_completed_tool_metadata() {
        let value = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "ses_1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call_1",
                    "status": "completed",
                    "title": "Notes\\presentation\\Agent 评测框架.md",
                    "rawOutput": {
                        "metadata": {
                            "display": {
                                "type": "file",
                                "path": "D:\\Notes\\presentation\\Agent 评测框架.md"
                            }
                        }
                    }
                }
            }
        });

        assert!(matches!(
            chunks_from_message("thread", &value).as_slice(),
            [
                AgentChunk::ToolCall { id, input, .. },
                AgentChunk::ToolResult { id: result_id, .. }
            ] if id == "call_1"
                && result_id == "call_1"
                && input.get("filePath").and_then(Value::as_str)
                    == Some("D:\\Notes\\presentation\\Agent 评测框架.md")
        ));
    }

    #[test]
    fn maps_permission_to_reject_for_read_only() {
        let value = json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "session/request_permission",
            "params": {
                "options": [
                    { "optionId": "yes", "kind": "allow_once" },
                    { "optionId": "no", "kind": "reject_once" }
                ]
            }
        });
        let response = permission_response(&value, Some("read-only"), &[]).unwrap();
        assert_eq!(
            response.pointer("/result/outcome/optionId"),
            Some(&json!("no"))
        );
    }

    #[test]
    fn workspace_write_only_allows_attached_roots() {
        let root = std::env::temp_dir();
        let allowed = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "session/request_permission",
            "params": {
                "toolCall": {
                    "toolCallId": "tool-1",
                    "title": "external directory",
                    "rawInput": { "parentDir": root }
                },
                "options": [
                    { "optionId": "yes", "kind": "allow_once" },
                    { "optionId": "no", "kind": "reject_once" }
                ]
            }
        });
        let response =
            permission_response(&allowed, Some("workspace-write"), &[root.clone()]).unwrap();
        assert_eq!(
            response.pointer("/result/outcome/optionId"),
            Some(&json!("yes"))
        );

        let denied = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "session/request_permission",
            "params": {
                "toolCall": {
                    "toolCallId": "tool-2",
                    "title": "external directory",
                    "rawInput": { "parentDir": root.join("outside") }
                },
                "options": [
                    { "optionId": "yes", "kind": "allow_once" },
                    { "optionId": "no", "kind": "reject_once" }
                ]
            }
        });
        let unrelated_root = root.join("allowed");
        let response =
            permission_response(&denied, Some("workspace-write"), &[unrelated_root]).unwrap();
        assert_eq!(
            response.pointer("/result/outcome/optionId"),
            Some(&json!("no"))
        );
    }

    #[test]
    fn file_uri_encodes_spaces() {
        let uri = path_to_file_uri(&std::env::temp_dir().join("image one.png").to_string_lossy());
        assert!(uri.starts_with("file:"));
        assert!(uri.contains("image%20one.png"));
    }

    #[test]
    fn prompt_resource_links_include_image_mime_type() {
        let request = prompt_request("session", "look", &["C:\\images\\photo.jpg".into()]);
        assert_eq!(
            request.pointer("/params/prompt/1/mimeType"),
            Some(&json!("image/jpeg"))
        );
    }
}
