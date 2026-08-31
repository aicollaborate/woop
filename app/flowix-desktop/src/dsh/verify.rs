//! DSH package verification.
//!
//! Runtime integrity protection relies on the SHA-256 and Minisign signature
//! pinned in the trusted platform manifest at
//! `download.flowix-memo.com/dsh/{platform}/latest.json`.

use super::manifest::DshArtifact;
use crate::update_security::{verify_sha256, verify_signature};

pub(super) fn verify_artifact(bytes: &[u8], artifact: &DshArtifact) -> Result<(), String> {
    verify_sha256(bytes, &artifact.sha256)
        .map_err(|error| format!("DSH package checksum mismatch: {error}"))?;
    let signature = artifact
        .signature
        .as_deref()
        .ok_or_else(|| "DSH package signature is missing".to_string())?;
    verify_signature(bytes, signature)
        .map_err(|error| format!("DSH package signature invalid: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn rejects_checksum_mismatch() {
        let a = DshArtifact {
            url: String::new(),
            sha256: "00".repeat(32),
            signature: Some(String::new()),
            size_bytes: None,
            build_id: None,
        };
        assert!(verify_artifact(b"payload", &a).is_err());
    }
    #[test]
    fn rejects_missing_signature_even_with_matching_checksum() {
        let a = DshArtifact {
            url: String::new(),
            sha256: format!("{:x}", Sha256::digest(b"payload")),
            signature: None,
            size_bytes: None,
            build_id: None,
        };
        assert!(verify_artifact(b"payload", &a)
            .unwrap_err()
            .contains("signature"));
    }
}
