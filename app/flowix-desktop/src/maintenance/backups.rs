use std::io;
use std::path::Path;

const BACKUP_PREFIX: &str = "thread.db.before-";
const KEEP_BACKUPS: usize = 2;

pub(super) fn prune(dir: &Path) -> io::Result<()> {
    let mut backups = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with(BACKUP_PREFIX) && name.ends_with(".sqlite") {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            backups.push((path, modified));
        }
    }
    backups.sort_by_key(|(_, modified)| *modified);
    while backups.len() > KEEP_BACKUPS {
        let (path, _) = backups.remove(0);
        let _ = std::fs::remove_file(&path);
        for suffix in ["-shm", "-wal"] {
            let sidecar = path.with_file_name(format!(
                "{}{}",
                path.file_name().unwrap().to_string_lossy(),
                suffix
            ));
            let _ = std::fs::remove_file(sidecar);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::prune;

    #[test]
    fn keeps_two_latest_backup_databases_and_removes_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        for index in 1..=3 {
            let base = dir.path().join(format!("thread.db.before-{index}.sqlite"));
            std::fs::write(&base, "backup").unwrap();
            std::fs::write(format!("{}-shm", base.display()), "shm").unwrap();
            std::fs::write(format!("{}-wal", base.display()), "wal").unwrap();
        }

        prune(dir.path()).unwrap();
        let databases = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".sqlite"))
            .count();
        assert_eq!(databases, 2);
        let sidecars = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                name.ends_with("-shm") || name.ends_with("-wal")
            })
            .count();
        assert_eq!(sidecars, 4);
    }
}
