use super::*;
use flowix_core::memo_file::MemoFile;

fn fixture() -> (tempfile::TempDir, MemoFile, ExportAccess, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let store = MemoFile::new(directory.path().join("config"));
    let target = directory.path().join("export.md");
    (directory, store, ExportAccess::default(), target)
}

#[test]
fn unselected_target_is_never_written() {
    let (_directory, store, access, target) = fixture();
    fs::write(&target, "private").unwrap();
    let error = access
        .save("main", &target, &mut &b"replacement"[..], &store)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(fs::read_to_string(&target).unwrap(), "private");
}

#[test]
fn revoked_dialog_generation_cannot_restore_an_export_grant() {
    let (_directory, store, access, target) = fixture();
    let generation = access.generation("main");
    access.revoke("main");
    assert!(access
        .grant_for_generation("main", generation, &target)
        .is_none());
    assert!(access
        .save("main", &target, &mut &b"denied"[..], &store)
        .is_err());
    assert!(!target.exists());
}

#[test]
fn changed_existing_target_is_not_overwritten() {
    let (_directory, store, access, target) = fixture();
    fs::write(&target, "original").unwrap();
    access.grant("main", &target).unwrap();
    fs::write(&target, "modified").unwrap();
    let error = access
        .save("main", &target, &mut &b"export"[..], &store)
        .unwrap_err();
    assert!(error.to_string().contains("EXPORT_CONTENT_CONFLICT"));
    assert_eq!(fs::read_to_string(&target).unwrap(), "modified");
}

#[test]
fn changes_during_streaming_are_detected_before_commit() {
    struct EditingReader {
        target: PathBuf,
    }
    impl Read for EditingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            fs::write(&self.target, "concurrent")?;
            Ok(0)
        }
    }
    let (_directory, store, access, target) = fixture();
    fs::write(&target, "original").unwrap();
    access.grant("main", &target).unwrap();
    assert!(access
        .save(
            "main",
            &target,
            &mut EditingReader {
                target: target.clone()
            },
            &store
        )
        .is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), "concurrent");
}

#[test]
fn authorization_is_window_scoped_and_single_use() {
    let (_directory, store, access, target) = fixture();
    access.grant("main", &target).unwrap();
    assert!(access
        .save("other", &target, &mut &b"other"[..], &store)
        .is_err());
    assert!(!target.exists());
    access
        .save("main", &target, &mut &b"selected"[..], &store)
        .unwrap();
    assert!(access
        .save("main", &target, &mut &b"again"[..], &store)
        .is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "selected");
}

#[test]
fn selection_does_not_authorize_siblings() {
    let (directory, store, access, target) = fixture();
    access.grant("main", &target).unwrap();
    let sibling = directory.path().join("private.md");
    assert!(access
        .save("main", &sibling, &mut &b"data"[..], &store)
        .is_err());
    assert!(!sibling.exists());
    access
        .save("main", &target, &mut &b"data"[..], &store)
        .unwrap();
}

#[test]
fn a_new_selection_revokes_the_previous_target() {
    let (directory, store, access, target) = fixture();
    access.grant("main", &target).unwrap();
    let replacement = directory.path().join("new.md");
    access.grant("main", &replacement).unwrap();
    assert!(access
        .save("main", &target, &mut &b"old"[..], &store)
        .is_err());
    access
        .save("main", &replacement, &mut &b"new"[..], &store)
        .unwrap();
}

#[test]
fn newly_created_target_cannot_be_overwritten_without_confirmation() {
    let (_directory, store, access, target) = fixture();
    access.grant("main", &target).unwrap();
    fs::write(&target, "concurrent work").unwrap();
    let error = access
        .save("main", &target, &mut &b"export"[..], &store)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read_to_string(&target).unwrap(), "concurrent work");
}

#[test]
fn selected_existing_file_is_atomically_replaced_with_binary_content() {
    let (_directory, store, access, target) = fixture();
    fs::write(&target, "original").unwrap();
    access.grant("main", &target).unwrap();
    let bytes = [0, 255, 128, 13, 10];
    access
        .save("main", &target, &mut bytes.as_slice(), &store)
        .unwrap();
    assert_eq!(fs::read(&target).unwrap(), bytes);
}

#[test]
fn failed_stream_preserves_existing_content_and_cleans_temporary_files() {
    struct BrokenReader;
    impl Read for BrokenReader {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("source unavailable"))
        }
    }
    let (directory, store, access, target) = fixture();
    fs::write(&target, "original").unwrap();
    access.grant("main", &target).unwrap();
    assert!(access
        .save("main", &target, &mut BrokenReader, &store)
        .is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "original");
    let names: Vec<_> = fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 2);
    assert!(access
        .save("main", &target, &mut &b"retry"[..], &store)
        .is_err());
}

#[test]
fn invalid_destination_is_not_granted() {
    let (directory, _store, access, _target) = fixture();
    assert!(access.grant("main", directory.path()).is_none());
    assert!(access.grant("main", Path::new("relative.md")).is_none());
    assert!(access
        .grant("main", &directory.path().join("missing/file.md"))
        .is_none());
}

#[test]
fn revoking_one_window_does_not_revoke_another() {
    let (_directory, store, access, target) = fixture();
    access.grant("main", &target).unwrap();
    access.grant("other", &target).unwrap();
    access.revoke("main");
    assert!(access
        .save("main", &target, &mut &b"denied"[..], &store)
        .is_err());
    access
        .save("other", &target, &mut &b"allowed"[..], &store)
        .unwrap();
}

#[cfg(unix)]
#[test]
fn symlink_substitution_does_not_redirect_export() {
    let (directory, store, access, target) = fixture();
    let private = directory.path().join("private.md");
    fs::write(&private, "private").unwrap();
    access.grant("main", &target).unwrap();
    std::os::unix::fs::symlink(&private, &target).unwrap();
    assert!(access
        .save("main", &target, &mut &b"export"[..], &store)
        .is_err());
    assert!(access.grant("main", &target).is_none());
    assert_eq!(fs::read_to_string(&private).unwrap(), "private");
}
