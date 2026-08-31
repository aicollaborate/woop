//! Shared verification for independently distributed Flowix artifacts.
//!
//! The public key is intentionally embedded in the client. The matching
//! private key must only exist in the release environment. Tauri's updater
//! uses the same Minisign format and the same public key for the desktop
//! application and DSH runtime updates.

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use sha2::{Digest, Sha256};

/// Base64-encoded contents of the public key used by Tauri updater.
pub const TAURI_UPDATER_PUBLIC_KEY: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRUEyNzZBMzYyMDQyNEI1MApSV1JRUzBJZ05tb242a1lBZDlLYnZJYkVXNm84VFIvTWZ2ODhLS29kM2lFaGVWSzBwejF2TEQyWgo=";

fn public_key() -> Result<PublicKey, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(TAURI_UPDATER_PUBLIC_KEY)
        .map_err(|error| format!("decode updater public key: {error}"))?;
    let contents = String::from_utf8(decoded)
        .map_err(|error| format!("decode updater public key text: {error}"))?;
    PublicKey::decode(&contents).map_err(|error| format!("parse updater public key: {error}"))
}

/// Verify the base64-encoded `.sig` value used by Tauri updater manifests.
pub fn verify_signature(bytes: &[u8], encoded_signature: &str) -> Result<(), String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded_signature.trim())
        .map_err(|error| format!("decode updater signature: {error}"))?;
    let contents = String::from_utf8(decoded)
        .map_err(|error| format!("decode updater signature text: {error}"))?;
    let signature = Signature::decode(&contents)
        .map_err(|error| format!("parse updater signature: {error}"))?;
    public_key()?
        .verify(bytes, &signature, true)
        .map_err(|error| format!("verify updater signature: {error}"))?;
    Ok(())
}

pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err(format!("sha256 mismatch: expected {expected}, got {actual}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_public_key_is_parseable() {
        assert!(public_key().is_ok());
    }

    #[test]
    fn verifies_sha256() {
        let bytes = b"flowix";
        let digest = format!("{:x}", Sha256::digest(bytes));
        assert!(verify_sha256(bytes, &digest).is_ok());
        assert!(verify_sha256(bytes, "00").is_err());
    }
}
