use std::fs;
use std::path::Path;

/// Replace the activation marker without leaving a window where Windows has
/// no current marker. Unix can replace directly; Windows first moves the old
/// marker aside and restores it if activation fails.
pub(super) fn activate_current(temp_path: &Path, current_path: &Path) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        return fs::rename(temp_path, current_path)
            .map_err(|e| format!("activate DSH version: {e}"));
    }

    #[cfg(windows)]
    {
        let backup_path =
            current_path.with_file_name(format!(".current-backup-{}", uuid::Uuid::new_v4()));
        let had_current = current_path.exists();
        if had_current {
            if let Err(error) = fs::rename(current_path, &backup_path) {
                let _ = fs::remove_file(temp_path);
                return Err(format!("stage previous DSH activation: {error}"));
            }
        }

        if let Err(error) = fs::rename(temp_path, current_path) {
            let _ = fs::remove_file(temp_path);
            if had_current {
                let _ = fs::rename(&backup_path, current_path);
            }
            return Err(format!("activate DSH version: {error}"));
        }

        if had_current {
            let _ = fs::remove_file(backup_path);
        }
        Ok(())
    }
}
