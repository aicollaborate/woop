// agent_supported_models) 与前�?invoke 不变�?// ─────────────────────────────────────────────────────────────────────────

/// 返回 Codex 默�? model id, 优先�?
///   1. `~/.codex/config.toml` 椤跺眰 `model = "..."`;
///   2. `codex debug models` 列表�?���?
///   3. 兜底�?���?`"gpt-5.5"`�?/// 仅用于前�?UI label 显示; 真�?运�? Codex �?`model == "inherit"` / �?/// 会走 `codex_cli::normalized_codex_model` 不传 `-m`�?
#[tauri::command]
pub async fn codex_default_model() -> Result<String, String> {
    if let Some(model) = read_codex_config_model() {
        return Ok(model);
    }

    if let Some(model) = query_codex_models().await?.first().cloned() {
        return Ok(model);
    }

    Ok("gpt-5.5".to_string())
}

/// �?agent type 返回后�?�?���?model id 列表。当前只�?`codex` 走动�?/// 查�? (�?�� `codex debug models`); 其余 type 返回�?── 前�?会回落到
/// 纭紪鐮?fallback (CODEX_MODEL_OPTIONS / CLAUDE_MODEL_OPTIONS)銆?
#[tauri::command]
pub async fn agent_supported_models(agent_type: String) -> Result<Vec<String>, String> {
    match agent_type.trim().to_ascii_lowercase().as_str() {
        "codex" => query_codex_models().await,
        _ => Ok(Vec::new()),
    }
}

async fn query_codex_models() -> Result<Vec<String>, String> {
    let mut cmd = crate::agent_external::codex::cli::build_codex_entrypoint();
    crate::process_window::hide_command_window(&mut cmd);
    let output = cmd
        .args(["debug", "models"])
        .output()
        .await
        .map_err(|e| format!("failed to query Codex models: {e}"))?;

    if output.status.success() {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            return Ok(parse_codex_models(&value));
        }
    }

    Ok(Vec::new())
}

fn parse_codex_models(value: &serde_json::Value) -> Vec<String> {
    let Some(models) = value.get("models").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    models
        .iter()
        .filter_map(|model| {
            model
                .get("slug")
                .or_else(|| model.get("id"))
                .or_else(|| model.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
        })
        .filter(|model| seen.insert((*model).to_string()))
        .map(str::to_string)
        .collect()
}

fn read_codex_config_model() -> Option<String> {
    let config_path = dirs::home_dir()?.join(".codex").join("config.toml");
    let content = std::fs::read_to_string(config_path).ok()?;
    parse_codex_config_model(&content)
}

/// 轻量解析 `~/.codex/config.toml` 顶层 `model = "..."`�?/// 不引入完�?TOML parser ── �?��这一�? 逐�?�?��即可�?
fn parse_codex_config_model(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let line = line.trim();
        if line.starts_with('#') || !line.starts_with("model") {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        if key.trim() != "model" {
            return None;
        }
        let value = value
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_config_model() {
        assert_eq!(
            parse_codex_config_model("model = \"gpt-5.5\"\n").as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(
            parse_codex_config_model("model = 'gpt-5-codex' # comment\n").as_deref(),
            Some("gpt-5-codex")
        );
        assert_eq!(parse_codex_config_model("service_tier = \"default\""), None);
    }

    #[test]
    fn parses_codex_supported_models() {
        let value = serde_json::json!({
            "models": [
                { "slug": "gpt-5.6" },
                { "id": "gpt-5.6-sol" },
                { "name": "gpt-5.6-terra" },
                { "slug": "gpt-5.6" },
                { "slug": "" }
            ]
        });

        assert_eq!(
            parse_codex_models(&value),
            vec!["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra"]
        );
    }
}
