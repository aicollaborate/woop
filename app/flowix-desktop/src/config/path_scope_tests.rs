use super::path_is_inside;
use std::fs;
use std::path::Path;

#[test]
fn relative_paths_cannot_define_an_authorization_boundary() {
    let directory = tempfile::tempdir().unwrap();
    assert!(!path_is_inside(Path::new("note.md"), directory.path()));
    assert!(!path_is_inside(directory.path(), Path::new(".")));
}

#[test]
fn missing_descendants_are_allowed_but_parent_escape_is_not() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("allowed");
    fs::create_dir(&root).unwrap();
    assert!(path_is_inside(&root.join("missing/nested/note.md"), &root));
    assert!(!path_is_inside(
        &root.join("missing/../../outside.md"),
        &root
    ));
}

#[test]
fn sibling_with_the_same_textual_prefix_is_not_inside() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("allowed");
    fs::create_dir(&root).unwrap();
    assert!(!path_is_inside(
        &directory.path().join("allowed-other/note.md"),
        &root
    ));
}

#[test]
fn regular_file_cannot_be_used_as_a_directory() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("file");
    fs::write(&file, "original").unwrap();
    assert!(!path_is_inside(&file.join("child"), directory.path()));
    assert_eq!(fs::read_to_string(&file).unwrap(), "original");
}

#[cfg(unix)]
#[test]
fn symlink_parent_components_follow_filesystem_semantics() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("allowed");
    let outside = directory.path().join("outside/child");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, root.join("link")).unwrap();
    assert!(!path_is_inside(&root.join("link/../secret.md"), &root));
    assert!(!path_is_inside(&root.join("link/new/note.md"), &root));
}

#[cfg(unix)]
#[test]
fn symlinks_with_internal_targets_and_root_aliases_remain_supported() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("allowed");
    fs::create_dir_all(root.join("child")).unwrap();
    symlink(root.join("child"), root.join("link")).unwrap();
    let alias = directory.path().join("alias");
    symlink(&root, &alias).unwrap();
    assert!(path_is_inside(&root.join("link/note.md"), &root));
    assert!(path_is_inside(&root.join("link/../note.md"), &root));
    assert!(path_is_inside(&alias.join("child/note.md"), &root));
    assert!(path_is_inside(&root.join("child/note.md"), &alias));
}

#[cfg(unix)]
#[test]
fn dangling_and_cyclic_symlinks_fail_closed() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    symlink(root.join("missing"), root.join("dangling")).unwrap();
    symlink(root.join("cycle"), root.join("cycle")).unwrap();
    for name in ["dangling", "cycle"] {
        assert!(!path_is_inside(&root.join(name), root));
        assert!(!path_is_inside(&root.join(name).join("note.md"), root));
    }
}
