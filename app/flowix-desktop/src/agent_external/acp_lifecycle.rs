use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn delete_session(mut command: Command, session_id: &str) -> Result<bool, String> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start ACP lifecycle process: {error}"))?;
    let result = async {
        let mut stdin = child.stdin.take().ok_or("ACP stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("ACP stdout unavailable")?;
        let mut stdout = BufReader::new(stdout);

        write_request(&mut stdin, json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": { "name": "Flowix", "version": env!("CARGO_PKG_VERSION") }
            }
        }))
        .await?;
        let initialize = read_response(&mut stdout, 1).await?;
        let supported = initialize
            .pointer("/result/agentCapabilities/sessionCapabilities/delete")
            .is_some();
        if !supported {
            return Ok(false);
        }

        write_request(&mut stdin, json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/delete",
            "params": { "sessionId": session_id }
        }))
        .await?;
        read_response(&mut stdout, 3).await?;
        Ok(true)
    };
    let result = tokio::time::timeout(REQUEST_TIMEOUT, result)
        .await
        .map_err(|_| "ACP lifecycle request timed out".to_string())?;
    let _ = child.kill().await;
    result
}

async fn write_request(stdin: &mut tokio::process::ChildStdin, value: Value) -> Result<(), String> {
    stdin
        .write_all(format!("{}\n", value).as_bytes())
        .await
        .map_err(|error| format!("failed to write ACP lifecycle request: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("failed to flush ACP lifecycle request: {error}"))
}

async fn read_response(stdout: &mut BufReader<tokio::process::ChildStdout>, id: u64) -> Result<Value, String> {
    loop {
        let mut line = String::new();
        let bytes = stdout
            .read_line(&mut line)
            .await
            .map_err(|error| format!("failed to read ACP lifecycle response: {error}"))?;
        if bytes == 0 {
            return Err(format!("ACP closed before response {id}"));
        }
        let value: Value = serde_json::from_str(line.trim())
            .map_err(|error| format!("invalid ACP lifecycle response: {error}"))?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!("ACP lifecycle request failed: {error}"));
        }
        return Ok(value);
    }
}

pub fn cwd_or_current(cwd: Option<std::path::PathBuf>) -> std::path::PathBuf {
    cwd.filter(|path| path.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| Path::new(".").to_path_buf())
}
