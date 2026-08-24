use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(super) fn dsh_plugin_environment() -> HashMap<String, String> {
    const KEYS: &[&str] = &[
        "PATH",
        "Path",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "NODE_USE_ENV_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ];
    KEYS.iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| ((*key).into(), value)))
        .collect()
}

/// Child-only overlay for a managed bundle; the Flowix process environment is
/// never mutated.
pub fn managed_child_environment(root: &Path) -> HashMap<String, String> {
    let mut environment = HashMap::new();
    let path_key = if cfg!(windows) { "Path" } else { "PATH" };
    let mut paths: Vec<PathBuf> = [root.join("bin"), root.join("node")]
        .into_iter()
        .filter(|path| path.is_dir())
        .collect();
    if let Some(parent) = std::env::var_os(path_key).or_else(|| std::env::var_os("PATH")) {
        paths.extend(std::env::split_paths(&parent));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        environment.insert(path_key.into(), path.to_string_lossy().into_owned());
    }
    environment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_overlay_prepends_only_existing_bundle_directories() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("bin")).unwrap();
        let overlay = managed_child_environment(temp.path());
        let key = if cfg!(windows) { "Path" } else { "PATH" };
        let paths = std::env::split_paths(overlay.get(key).unwrap()).collect::<Vec<_>>();
        assert_eq!(paths.first(), Some(&temp.path().join("bin")));
        assert!(!paths.contains(&temp.path().join("node")));
    }
}
