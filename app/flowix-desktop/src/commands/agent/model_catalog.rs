// agent_supported_models) 与前�?invoke 不变�?// ─────────────────────────────────────────────────────────────────────────
use tauri::State;

/// Return the default picker value from the Codex App Server model catalog.
/// The literal fallback only keeps the existing UI usable when the catalog is
/// temporarily empty.
#[tauri::command]
pub async fn codex_default_model(
    state: State<'_, crate::app::state::AppState>,
) -> Result<String, String> {
    if let Some(model) = state
        .codex_app_server
        .supported_models()
        .await?
        .first()
        .cloned()
    {
        return Ok(model);
    }

    Ok("gpt-5.5".to_string())
}

/// Return runtime-supported model ids. Codex discovery is delegated to its
/// long-lived App Server; other runtimes keep their existing catalog sources.
#[tauri::command]
pub async fn agent_supported_models(
    agent_type: String,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Vec<String>, String> {
    match agent_type.trim().to_ascii_lowercase().as_str() {
        "codex" => state.codex_app_server.supported_models().await,
        "opencode" => query_opencode_models().await,
        "deepseek-harness" | "deepseek_harness" | "dsh" => {
            state.deepseek_harness.supported_models().await
        }
        _ => Ok(Vec::new()),
    }
}

/// OpenCode publishes the currently configured provider/model routes through
/// its `models` command. Keep this discovery separate from the ACP process:
/// the ACP server itself is long-lived per turn, while the selector needs a
/// cheap catalog that can be refreshed when the popover opens.
async fn query_opencode_models() -> Result<Vec<String>, String> {
    let mut command =
        tokio::process::Command::new(crate::agent_external::opencode::resolve_opencode_binary());
    crate::process_window::hide_command_window(&mut command);
    let output = command
        .args(["models"])
        .output()
        .await
        .map_err(|e| format!("failed to query OpenCode models: {e}"))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }
    let mut seen = std::collections::HashSet::new();
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .filter(|model| seen.insert((*model).to_string()))
        .map(str::to_string)
        .collect())
}
