use super::manifest::DshArtifact;
use minisign_verify::{PublicKey, Signature};
use sha2::{Digest, Sha256};

const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("FLOWIX_DSH_UPDATE_PUBLIC_KEY");

pub(super) fn verify_artifact(bytes: &[u8], artifact: &DshArtifact) -> Result<(), String> {
    let digest = format!("{:x}", Sha256::digest(bytes));
    if !digest.eq_ignore_ascii_case(artifact.sha256.trim()) {
        return Err(format!(
            "DSH package checksum mismatch: expected {}, got {}",
            artifact.sha256, digest
        ));
    }
    if let Some(signature_text) = artifact.signature.as_deref() {
        match UPDATE_PUBLIC_KEY {
            Some(public_key) => {
                let key = PublicKey::decode(public_key).map_err(|e| format!("parse DSH update public key: {e}"))?;
                let signature = Signature::decode(signature_text).map_err(|e| format!("parse DSH package signature: {e}"))?;
                key.verify(bytes, &signature, false).map_err(|e| format!("verify DSH package signature: {e}"))?;
            }
            None if cfg!(debug_assertions) => tracing::warn!("DSH package signature was not cryptographically verified: no public key in dev build"),
            None => return Err("DSH package is signed but this Flowix build has no DSH public key".into()),
        }
    } else if UPDATE_PUBLIC_KEY.is_some() {
        return Err(
            "DSH package is unsigned but this is a signature-enforcing Flowix build".into(),
        );
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
            signature: None,
            build_id: None,
        };
        assert!(verify_artifact(b"payload", &a)
            .unwrap_err()
            .contains("checksum mismatch"));
    }
    #[test]
    fn accepts_matching_checksum_when_signatures_are_not_enforced() {
        let a = DshArtifact {
            url: String::new(),
            sha256: format!("{:x}", Sha256::digest(b"payload")),
            size_bytes: None,
            signature: None,
            build_id: None,
        };
        if UPDATE_PUBLIC_KEY.is_none() {
            assert!(verify_artifact(b"payload", &a).is_ok());
        }
    }
}
