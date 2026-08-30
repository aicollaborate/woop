use reqwest::blocking::Client;
use serde::Deserialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::time::Duration;

const MANIFEST_ENV: &str = "FLOWIX_DSH_MANIFEST_URL";
const DEFAULT_MANIFEST_BASE: &str = "https://download.flowix-memo.com/dsh";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DshManifest {
    pub(super) schema_version: u64,
    pub(super) product: String,
    pub(super) version: String,
    pub(super) protocol_version: u64,
    #[serde(default)]
    pub(super) min_flowix_version: Option<String>,
    pub(super) platforms: HashMap<String, DshArtifact>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DshArtifact {
    pub(super) url: String,
    pub(super) sha256: String,
    #[serde(default)]
    pub(super) size_bytes: Option<u64>,
    #[serde(default)]
    pub(super) build_id: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum DshVersion {
    Legacy(semver::Version),
    Sequence(u64),
}

impl DshVersion {
    fn parse(value: &str) -> Result<Self, String> {
        if let Some(serial) = value.strip_prefix("dsh.") {
            let is_two_digit_padded = serial.len() == 2
                && serial.starts_with('0')
                && serial.as_bytes()[1].is_ascii_digit()
                && serial.as_bytes()[1] != b'0';
            let is_unpadded = serial.len() >= 2
                && !serial.starts_with('0')
                && serial.bytes().all(|byte| byte.is_ascii_digit());
            if !(is_two_digit_padded || is_unpadded) {
                return Err(format!("invalid DSH sequence version {value}"));
            }
            let sequence = serial
                .parse::<u64>()
                .map_err(|_| format!("invalid DSH sequence version {value}"))?;
            return Ok(Self::Sequence(sequence));
        }
        semver::Version::parse(value)
            .map(Self::Legacy)
            .map_err(|error| format!("invalid legacy DSH version {value}: {error}"))
    }
}

impl Ord for DshVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Legacy(left), Self::Legacy(right)) => left.cmp(right),
            (Self::Sequence(left), Self::Sequence(right)) => left.cmp(right),
            (Self::Legacy(_), Self::Sequence(_)) => Ordering::Less,
            (Self::Sequence(_), Self::Legacy(_)) => Ordering::Greater,
        }
    }
}

impl PartialOrd for DshVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub(super) fn manifest_url() -> String {
    std::env::var(MANIFEST_ENV)
        .unwrap_or_else(|_| format!("{DEFAULT_MANIFEST_BASE}/{}/latest.json", platform_group()))
}

fn platform_group() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}
pub(super) fn fetch_manifest() -> Result<DshManifest, String> {
    let manifest: DshManifest = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("create DSH manifest client: {e}"))?
        .get(manifest_url())
        .send()
        .map_err(|e| format!("download DSH manifest: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download DSH manifest: {e}"))?
        .json()
        .map_err(|e| format!("parse DSH manifest: {e}"))?;
    if !matches!(manifest.schema_version, 1 | 2) || manifest.product != "flowix-dsh" {
        return Err("DSH manifest schema or product mismatch".into());
    }
    validate_manifest_version(&manifest.version)?;
    Ok(manifest)
}
pub(super) fn dsh_version_is_at_least(current: &str, required: &str) -> Result<bool, String> {
    let current = DshVersion::parse(current.trim())?;
    let required = DshVersion::parse(required.trim())?;
    Ok(current >= required)
}

pub(super) fn flowix_version_is_at_least(current: &str, required: &str) -> Result<bool, String> {
    let current = semver::Version::parse(current.trim())
        .map_err(|e| format!("invalid Flowix version {current}: {e}"))?;
    let required = semver::Version::parse(required.trim())
        .map_err(|e| format!("invalid required Flowix version {required}: {e}"))?;
    Ok(current >= required)
}

pub(super) fn validate_manifest_version(version: &str) -> Result<(), String> {
    if version.trim() != version {
        return Err("DSH manifest version must not contain surrounding whitespace".into());
    }
    DshVersion::parse(version).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compares_legacy_dsh_versions_numerically() {
        assert!(dsh_version_is_at_least("1.10.0", "1.9.0").unwrap());
        assert!(!dsh_version_is_at_least("1.2.0", "1.2.1").unwrap());
    }

    #[test]
    fn compares_named_dsh_versions_numerically() {
        assert!(dsh_version_is_at_least("dsh.10", "dsh.09").unwrap());
        assert!(dsh_version_is_at_least("dsh.100", "dsh.10").unwrap());
        assert!(dsh_version_is_at_least("dsh.01", "1.0.4").unwrap());
        assert!(!dsh_version_is_at_least("dsh.01", "dsh.02").unwrap());
    }

    #[test]
    fn keeps_flowix_versions_on_semver() {
        assert!(flowix_version_is_at_least("1.10.0", "1.9.0").unwrap());
        assert!(!flowix_version_is_at_least("1.2.0", "1.2.1").unwrap());
    }
    #[test]
    fn rejects_ambiguous_versions() {
        assert!(validate_manifest_version("1.2.3").is_ok());
        assert!(validate_manifest_version("dsh.01").is_ok());
        assert!(validate_manifest_version("dsh.10").is_ok());
        assert!(validate_manifest_version(" 1.2.3").is_err());
        assert!(validate_manifest_version("latest").is_err());
        assert!(validate_manifest_version("dsh.00").is_err());
        assert!(validate_manifest_version("dsh.1").is_err());
        assert!(validate_manifest_version("dsh.001").is_err());
    }

    #[test]
    fn uses_platform_specific_default_manifest() {
        let url = manifest_url();
        assert!(
            url.ends_with("/windows/latest.json")
                || url.ends_with("/macos/latest.json")
                || url.ends_with("/linux/latest.json")
                || url.ends_with("/unknown/latest.json")
        );
    }
}
