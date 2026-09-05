use std::io;
use std::path::Path;

const LOG_POLICIES: &[(&str, u64, usize)] = &[
    ("app.log", 10 * 1024 * 1024, 3),
    ("error.log", 20 * 1024 * 1024, 5),
    ("agent.log", 50 * 1024 * 1024, 3),
];

pub(super) fn rotate(dir: &Path) -> io::Result<()> {
    for (name, max_bytes, keep) in LOG_POLICIES {
        rotate_one(&dir.join(name), *max_bytes, *keep)?;
    }
    Ok(())
}

fn rotate_one(path: &Path, max_bytes: u64, keep: usize) -> io::Result<()> {
    if path.metadata().map(|m| m.len()).unwrap_or(0) <= max_bytes {
        return Ok(());
    }
    for index in (1..keep).rev() {
        let old = path.with_extension(format!("log.{index}"));
        let new = path.with_extension(format!("log.{}", index + 1));
        if old.exists() {
            let _ = std::fs::remove_file(&new);
            std::fs::rename(old, new)?;
        }
    }
    let first = path.with_extension("log.1");
    let _ = std::fs::remove_file(&first);
    std::fs::rename(path, first)
}

#[cfg(test)]
mod tests {
    use super::rotate_one;

    #[test]
    fn rotates_only_when_log_exceeds_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "12345").unwrap();

        rotate_one(&path, 4, 3).unwrap();
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("app.log.1")).unwrap(),
            "12345"
        );

        std::fs::write(&path, "1234").unwrap();
        rotate_one(&path, 5, 3).unwrap();
        assert!(path.exists());
        assert!(!dir.path().join("app.log.2").exists());
    }

    #[test]
    fn keeps_only_configured_rotated_logs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        for suffix in ["", ".1", ".2", ".3"] {
            std::fs::write(
                if suffix.is_empty() {
                    path.clone()
                } else {
                    path.with_extension(format!("log{suffix}"))
                },
                "large",
            )
            .unwrap();
        }

        rotate_one(&path, 1, 3).unwrap();
        assert!(path.with_extension("log.1").exists());
        assert!(path.with_extension("log.2").exists());
        assert!(path.with_extension("log.3").exists());
        assert!(!path.with_extension("log.4").exists());
    }
}
