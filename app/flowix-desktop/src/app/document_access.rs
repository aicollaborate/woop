use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Default)]
pub struct DocumentAccess {
    paths: RwLock<HashSet<(String, PathBuf)>>,
    generations: RwLock<HashMap<String, u64>>,
}

impl DocumentAccess {
    pub fn grant(&self, window: &str, path: &Path) -> bool {
        self.grant_for_generation(window, self.generation(window), path)
    }

    pub fn generation(&self, window: &str) -> u64 {
        self.generations
            .read()
            .map(|values| *values.get(window).unwrap_or(&0))
            .unwrap_or(u64::MAX)
    }

    pub fn grant_for_generation(&self, window: &str, generation: u64, path: &Path) -> bool {
        let Ok(generations) = self.generations.read() else {
            return false;
        };
        if *generations.get(window).unwrap_or(&0) != generation {
            return false;
        }
        let Some(path) = existing_file(path) else {
            return false;
        };
        let Ok(mut paths) = self.paths.write() else {
            return false;
        };
        paths.insert((window.to_string(), path));
        true
    }

    pub fn contains(&self, window: &str, path: &Path) -> bool {
        if self.generations.read().is_err() {
            return false;
        }
        let Some(path) = existing_file(path) else {
            return false;
        };
        self.paths
            .read()
            .is_ok_and(|paths| paths.contains(&(window.to_string(), path)))
    }

    pub fn revoke(&self, window: &str) {
        let Ok(mut generations) = self.generations.write() else {
            return;
        };
        let generation = generations.entry(window.to_string()).or_default();
        *generation = generation.saturating_add(1);
        if let Ok(mut paths) = self.paths.write() {
            paths.retain(|(owner, _)| owner != window);
        }
    }
}

fn existing_file(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = dunce::canonicalize(path).ok()?;
    canonical.is_file().then_some(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_a_window_invalidates_pending_dialog_grants() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("file.md");
        std::fs::write(&path, "data").unwrap();
        let access = DocumentAccess::default();
        let generation = access.generation("main");
        access.revoke("main");
        assert!(!access.grant_for_generation("main", generation, &path));
        assert!(!access.contains("main", &path));
    }

    #[test]
    fn grants_are_isolated_and_revoked_per_window() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("private.md");
        std::fs::write(&file, "private").unwrap();
        let access = DocumentAccess::default();
        assert!(access.grant("first", &file));
        assert!(!access.contains("second", &file));
        assert!(access.grant("second", &file));
        access.revoke("first");
        assert!(!access.contains("first", &file));
        assert!(access.contains("second", &file));
    }

    #[test]
    fn extension_alone_never_grants_access() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.md");
        std::fs::write(&path, "private").unwrap();
        assert!(!DocumentAccess::default().contains("main", &path));
    }

    #[test]
    fn explicit_grant_does_not_authorize_siblings() {
        let directory = tempfile::tempdir().unwrap();
        let selected = directory.path().join("selected.md");
        let sibling = directory.path().join("private.md");
        std::fs::write(&selected, "selected").unwrap();
        std::fs::write(&sibling, "private").unwrap();
        let access = DocumentAccess::default();
        assert!(access.grant("main", &selected));
        assert!(access.contains("main", &selected));
        assert!(!access.contains("main", &sibling));
        assert!(!DocumentAccess::default().contains("main", &selected));
    }

    #[test]
    fn invalid_grants_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let access = DocumentAccess::default();
        for path in [
            directory.path(),
            Path::new("relative.md"),
            &directory.path().join("missing.md"),
        ] {
            assert!(!access.grant("main", path));
            assert!(!access.contains("main", path));
        }
    }

    #[test]
    fn atomic_replacement_preserves_path_authorization() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected.md");
        std::fs::write(&path, "original").unwrap();
        let access = DocumentAccess::default();
        assert!(access.grant("main", &path));
        flowix_core::memo_file::atomic_write_bytes(&path, b"saved").unwrap();
        assert!(access.contains("main", &path));
        std::fs::remove_file(&path).unwrap();
        assert!(!access.contains("main", &path));
    }

    #[cfg(unix)]
    #[test]
    fn retargeted_symlink_does_not_inherit_authorization() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original.md");
        let private = directory.path().join("private.md");
        let alias = directory.path().join("alias.md");
        std::fs::write(&original, "original").unwrap();
        std::fs::write(&private, "private").unwrap();
        symlink(&original, &alias).unwrap();
        let access = DocumentAccess::default();
        assert!(access.grant("main", &alias));
        assert!(access.contains("main", &original));
        std::fs::remove_file(&alias).unwrap();
        symlink(&private, &alias).unwrap();
        assert!(!access.contains("main", &alias));
    }
}
