use std::path::{Path, PathBuf};
pub(super) fn normalized_sha256(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("DSH manifest contains an invalid SHA-256 digest".into());
    }
    Ok(value)
}
pub(super) fn partial_download_path(root: &Path, sha256: &str) -> PathBuf {
    root.join("downloads").join(format!("{sha256}.part"))
}
pub(super) fn response_resumes(existing: u64, status: reqwest::StatusCode) -> bool {
    existing > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_digest_before_path_use() {
        let d = normalized_sha256(&"AB".repeat(32)).unwrap();
        assert_eq!(d, "ab".repeat(32));
        assert!(normalized_sha256("../x").is_err());
        assert_eq!(
            partial_download_path(Path::new("r"), &d),
            Path::new("r").join("downloads").join(format!("{d}.part"))
        );
    }
    #[test]
    fn only_206_with_existing_bytes_is_a_resume() {
        assert!(response_resumes(10, reqwest::StatusCode::PARTIAL_CONTENT));
        assert!(!response_resumes(10, reqwest::StatusCode::OK));
        assert!(!response_resumes(0, reqwest::StatusCode::PARTIAL_CONTENT));
    }
}
