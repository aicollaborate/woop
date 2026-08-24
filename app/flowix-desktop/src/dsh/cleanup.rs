use std::{fs, path::Path};
pub(super) fn remove_runtime_root(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    if !root.is_dir() {
        return Err(format!("DSH root {} is not a directory", root.display()));
    }
    let current = root.join("current.json");
    if current.exists() {
        fs::remove_file(&current).map_err(|e| format!("deactivate DSH installation: {e}"))?;
    }
    fs::remove_dir_all(root).map_err(|e| format!("remove DSH runtime {}: {e}", root.display()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn is_idempotent_and_rejects_file_root() {
        let t = tempfile::tempdir().unwrap();
        assert!(remove_runtime_root(&t.path().join("missing")).is_ok());
        let f = t.path().join("file");
        fs::write(&f, b"x").unwrap();
        assert!(remove_runtime_root(&f).is_err());
    }
}
