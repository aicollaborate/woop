use crate::connection_probe::{TestConnectionError, TestConnectionErrorKind, TestConnectionResult};
use std::time::Instant;

pub(crate) fn harness_probe_failure(
    model_id: &str,
    started: Instant,
    kind: TestConnectionErrorKind,
    message: String,
) -> TestConnectionResult {
    TestConnectionResult {
        ok: false,
        latency_ms: started.elapsed().as_millis() as u64,
        model_id: model_id.into(),
        summary: String::new(),
        error: Some(TestConnectionError { kind, message }),
    }
}

pub(crate) fn validate_plugin_key(plugin_key: &str) -> Result<(), String> {
    let parts = plugin_key.split(':').collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty()) {
        return Err("DeepSeek Harness plugin key is invalid".into());
    }
    if matches!(parts.as_slice(), ["host", _])
        || matches!(parts.as_slice(), ["host", index, _] if index.chars().all(|c| c.is_ascii_digit()))
    {
        return Err("Host-level Harness plugins are managed by Flowix composition".into());
    }
    let valid_preset = |preset: &str| matches!(preset, "standard" | "code" | "minimal" | "cordis");
    if matches!(parts.as_slice(), ["preset", preset, _] if valid_preset(preset))
        || matches!(parts.as_slice(), ["preset", preset, index, _] if valid_preset(preset) && index.chars().all(|c| c.is_ascii_digit()))
    {
        return Ok(());
    }
    Err("DeepSeek Harness plugin key is invalid".into())
}

pub(crate) fn resolved_session_id(value: serde_json::Value) -> Result<String, String> {
    value
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "DeepSeek Harness did not return a session id".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_preset_scoped_plugin_keys() {
        assert!(validate_plugin_key("preset:code:memory").is_ok());
        assert!(validate_plugin_key("preset:code:2:memory").is_ok());
        assert!(validate_plugin_key("host:memory").is_err());
        assert!(validate_plugin_key("preset:unknown:memory").is_err());
        assert!(validate_plugin_key("preset::memory").is_err());
    }

    #[test]
    fn requires_a_non_empty_session_id() {
        assert_eq!(
            resolved_session_id(json!({"sessionId":"s-1"})).unwrap(),
            "s-1"
        );
        assert!(resolved_session_id(json!({"sessionId":""})).is_err());
        assert!(resolved_session_id(json!({})).is_err());
    }
}
