pub(super) fn initialize_is_healthy(
    value: &serde_json::Value,
    protocol: u64,
    required: &[&str],
) -> bool {
    if value.get("error").is_some() {
        return false;
    }
    let result = value.get("result");
    result
        .and_then(|v| v.get("protocolVersion"))
        .and_then(serde_json::Value::as_u64)
        == Some(protocol)
        && result
            .and_then(|v| v.get("capabilities"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|values| {
                required
                    .iter()
                    .all(|r| values.iter().any(|v| v.as_str() == Some(r)))
            })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn requires_protocol_and_all_capabilities() {
        let v = json!({"result":{"protocolVersion":1,"capabilities":["models","runs"]}});
        assert!(initialize_is_healthy(&v, 1, &["models", "runs"]));
        assert!(!initialize_is_healthy(&v, 2, &["models"]));
        assert!(!initialize_is_healthy(&v, 1, &["models", "plugins"]));
    }
}
