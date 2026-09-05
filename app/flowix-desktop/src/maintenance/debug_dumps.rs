use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

const MAX_DEBUG_BYTES: u64 = 200 * 1024 * 1024;
const MAX_DEBUG_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub(super) fn cleanup(dir: &Path) -> io::Result<()> {
    cleanup_with_policy(dir, SystemTime::now(), MAX_DEBUG_AGE, MAX_DEBUG_BYTES)
}

fn cleanup_with_policy(
    dir: &Path,
    now: SystemTime,
    max_age: Duration,
    max_bytes: u64,
) -> io::Result<()> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = entry.metadata()?;
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if now.duration_since(modified).unwrap_or_default() > max_age {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        files.push((path, metadata.len(), modified));
    }

    let mut total = files.iter().map(|(_, size, _)| *size).sum::<u64>();
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in files {
        if total <= max_bytes {
            break;
        }
        let _ = std::fs::remove_file(&path);
        total = total.saturating_sub(size);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::cleanup_with_policy;
    use std::time::{Duration, SystemTime};

    #[test]
    fn removes_old_debug_dumps_and_keeps_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.jsonl");
        let other = dir.path().join("notes.txt");
        std::fs::write(&old, "old").unwrap();
        std::fs::write(&other, "keep").unwrap();

        cleanup_with_policy(
            dir.path(),
            SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60),
            Duration::from_secs(7 * 24 * 60 * 60),
            200,
        )
        .unwrap();
        assert!(!old.exists());
        assert!(other.exists());
    }

    #[test]
    fn bounds_debug_dump_total_size() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.jsonl"), "1234").unwrap();
        std::fs::write(dir.path().join("b.jsonl"), "5678").unwrap();

        cleanup_with_policy(
            dir.path(),
            SystemTime::now(),
            Duration::from_secs(7 * 24 * 60 * 60),
            5,
        )
        .unwrap();
        let remaining = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(remaining, 1);
    }
}
