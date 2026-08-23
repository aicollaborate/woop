use flate2::read::GzDecoder;
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};
use tar::Archive;

use super::{MAX_ARCHIVE_ENTRIES, MAX_EXTRACTED_BYTES};

pub(super) fn extract_archive(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(bytes);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|e| format!("read DSH archive: {e}"))?;
    let mut entry_count = 0u64;
    let mut extracted_bytes = 0u64;
    for entry in entries {
        super::check_cancelled()?;
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "DSH archive contains more than {MAX_ARCHIVE_ENTRIES} entries"
            ));
        }
        let mut entry = entry.map_err(|e| format!("read DSH archive entry: {e}"))?;
        let entry_size = entry
            .header()
            .size()
            .map_err(|e| format!("read DSH archive entry size: {e}"))?;
        extracted_bytes = extracted_bytes
            .checked_add(entry_size)
            .ok_or_else(|| "DSH archive extracted size overflow".to_string())?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err(format!(
                "DSH archive expands beyond {} GiB limit",
                MAX_EXTRACTED_BYTES / 1024 / 1024 / 1024
            ));
        }
        let relative = safe_archive_path(
            entry
                .path()
                .map_err(|e| format!("read DSH archive path: {e}"))?
                .as_ref(),
        )?;
        if entry.header().entry_type().is_symlink() || entry.header().entry_type().is_hard_link() {
            return Err(format!(
                "DSH archive contains a link: {}",
                relative.display()
            ));
        }
        let target = destination.join(relative);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("create DSH directory: {e}"))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("create DSH directory: {e}"))?;
            }
            let mut output = File::create(&target).map_err(|e| format!("create DSH file: {e}"))?;
            std::io::copy(&mut entry, &mut output).map_err(|e| format!("extract DSH file: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                // Preserve ordinary rwx bits required by the SEA spawn helper,
                // while deliberately stripping setuid/setgid/sticky bits from
                // downloaded archives.
                let mode = entry
                    .header()
                    .mode()
                    .map_err(|e| format!("read DSH archive file mode: {e}"))?
                    & 0o777;
                fs::set_permissions(&target, fs::Permissions::from_mode(mode))
                    .map_err(|e| format!("set DSH archive file mode: {e}"))?;
            }
        }
    }
    Ok(())
}

pub(super) fn safe_archive_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!("unsafe DSH archive path: {}", path.display()));
    }
    Ok(path.to_path_buf())
}
