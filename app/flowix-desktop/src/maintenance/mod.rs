//! Best-effort housekeeping for files and local SQLite state.
//!
//! Startup maintenance runs after the Tauri state is available and never
//! blocks window creation. Shutdown maintenance is intentionally limited to a
//! final WAL checkpoint.

mod backups;
mod debug_dumps;
mod logs;
mod sqlite;

use std::path::PathBuf;
use std::sync::Arc;

use crate::agent_session::ThreadManager;

const LEGACY_EVENTS_CLEANUP_MARKER: &str = "legacy-non-claude-events-v1.done";

pub(crate) fn spawn_startup_maintenance(
    app_version: String,
    user_config_dir: PathBuf,
    thread_manager: Arc<ThreadManager>,
) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = logs::rotate(&user_config_dir.join("logs")) {
            tracing::warn!("startup log maintenance failed: {error}");
        }
        if let Err(error) = debug_dumps::cleanup(&user_config_dir.join("debug")) {
            tracing::warn!("startup debug maintenance failed: {error}");
        }
        if let Err(error) = backups::prune(&user_config_dir) {
            tracing::warn!("startup backup maintenance failed: {error}");
        }

        if should_cleanup_legacy_events(&app_version, &user_config_dir) {
            match sqlite::delete_non_claude_events(&thread_manager) {
                Ok(count) => {
                    if let Err(error) = mark_legacy_events_cleaned(&user_config_dir) {
                        tracing::warn!("legacy event cleanup marker failed: {error}");
                    }
                    tracing::info!(
                        "removed {count} legacy non-Claude external events during maintenance"
                    );
                    if let Err(error) = thread_manager.checkpoint_wal() {
                        tracing::warn!("legacy event WAL checkpoint failed: {error}");
                    }
                }
                Err(error) => {
                    tracing::warn!("legacy non-Claude event cleanup failed: {error}");
                }
            }
        }
    });
}

pub(crate) fn run_shutdown_maintenance(thread_manager: &ThreadManager) {
    if let Err(error) = sqlite::checkpoint_wal(thread_manager) {
        tracing::warn!("shutdown SQLite maintenance failed: {error}");
    }
}

fn should_cleanup_legacy_events(version: &str, user_config_dir: &std::path::Path) -> bool {
    let Ok(version) = semver::Version::parse(version) else {
        tracing::warn!("cannot compare app version {version:?} for legacy event cleanup");
        return false;
    };
    version >= semver::Version::new(1, 2, 8)
        && !user_config_dir
            .join("maintenance")
            .join(LEGACY_EVENTS_CLEANUP_MARKER)
            .exists()
}

fn mark_legacy_events_cleaned(user_config_dir: &std::path::Path) -> std::io::Result<()> {
    let dir = user_config_dir.join("maintenance");
    std::fs::create_dir_all(&dir)?;
    let marker = dir.join(LEGACY_EVENTS_CLEANUP_MARKER);
    let temp = dir.join(format!(
        ".{LEGACY_EVENTS_CLEANUP_MARKER}.tmp-{}",
        std::process::id()
    ));
    std::fs::write(&temp, b"completed\n")?;
    std::fs::rename(temp, marker)
}

#[cfg(test)]
mod tests {
    use super::{mark_legacy_events_cleaned, should_cleanup_legacy_events};

    #[test]
    fn legacy_cleanup_requires_version_after_cutoff() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!should_cleanup_legacy_events("1.2.7", dir.path()));
        assert!(should_cleanup_legacy_events("1.2.8", dir.path()));
        assert!(should_cleanup_legacy_events("1.2.11", dir.path()));
    }

    #[test]
    fn cleanup_marker_makes_maintenance_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        mark_legacy_events_cleaned(dir.path()).unwrap();
        assert!(!should_cleanup_legacy_events("1.2.11", dir.path()));
    }
}
