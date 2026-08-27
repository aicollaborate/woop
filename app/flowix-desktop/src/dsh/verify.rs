//! DSH package verification.
//!
//! Runtime integrity protection relies on the SHA-256 pinned in the trusted
//! manifest at `download.flowix-memo.com/dsh/latest.json`, plus HTTPS transport.

use super::manifest::DshArtifact;
use sha2::{Digest, Sha256};

pub(super) fn verify_artifact(bytes: &[u8], artifact: &DshArtifact) -> Result<(), String> {
    let digest = format!("{:x}", Sha256::digest(bytes));
    if !digest.eq_ignore_ascii_case(artifact.sha256.trim()) {
        return Err(format!(
            "DSH package checksum mismatch: expected {}, got {}",
            artifact.sha256, digest
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_checksum_mismatch() {
        let a = DshArtifact {
            url: String::new(),
            sha256: "00".repeat(32),
            size_bytes: None,
            build_id: None,
        };
        assert!(verify_artifact(b"payload", &a)
            .unwrap_err()
            .contains("checksum mismatch"));
    }
    #[test]
    fn accepts_matching_checksum() {
        let a = DshArtifact {
            url: String::new(),
            sha256: format!("{:x}", Sha256::digest(b"payload")),
            size_bytes: None,
            build_id: None,
        };
        assert!(verify_artifact(b"payload", &a).is_ok());
    }
}
