use std::path::{Path, PathBuf};
pub(super) fn safe_bundle_path(
    root: &Path,
    relative: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
    {
        return Err(format!("DSH {label} must be a safe relative path"));
    }
    Ok(root.join(relative))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confines_bundle_paths() {
        let r = Path::new("runtime");
        assert!(safe_bundle_path(r, "../host", "host").is_err());
        assert!(safe_bundle_path(r, "/host", "host").is_err());
        assert_eq!(
            safe_bundle_path(r, "bin/host", "host").unwrap(),
            r.join("bin/host")
        );
    }
}
