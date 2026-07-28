use super::*;
use crate::models::{CloudAccount, CloudUser, CloudWorkspace};

#[test]
fn settings_account_and_notebook_links_round_trip() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    assert!(!store.enabled().unwrap());
    store.set_enabled(true).unwrap();
    assert!(store.enabled().unwrap());

    let account = CloudAccount {
        user: CloudUser {
            id: "usr_1".into(),
            email: "a@example.com".into(),
            display_name: "A".into(),
            system_role: "user".into(),
        },
        workspace: CloudWorkspace {
            id: "ws_1".into(),
            name: Some("A".into()),
            slug: "a".into(),
            role: "owner".into(),
            kind: Some("personal".into()),
        },
    };
    store.save_account(&account).unwrap();
    assert_eq!(store.account().unwrap(), Some(account));

    let link = store
        .set_notebook("nb_1", "ws_1", "cloud_nb_1", true)
        .unwrap();
    assert!(link.enabled);
    assert_eq!(link.cloud_notebook_id, "cloud_nb_1");
    assert_eq!(store.enabled_notebooks("ws_1").unwrap().len(), 1);
    store.disable_notebook("ws_1", "nb_1").unwrap();
    assert!(store.enabled_notebooks("ws_1").unwrap().is_empty());
    store.forget_notebook("nb_1").unwrap();
    assert_eq!(store.notebook_link("ws_1", "nb_1").unwrap(), None);
}

#[test]
fn sync_state_is_isolated_by_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store
        .set_notebook("nb_shared", "ws_1", "cloud_nb_1", true)
        .unwrap();
    store
        .set_notebook("nb_shared", "ws_2", "cloud_nb_2", true)
        .unwrap();
    store
        .save_note_state("ws_1", "nb_shared", "note_1", "rev_1", "hash_1")
        .unwrap();
    store
        .save_note_state("ws_2", "nb_shared", "note_1", "rev_2", "hash_2")
        .unwrap();

    assert_eq!(
        store
            .note_state("ws_1", "nb_shared", "note_1")
            .unwrap()
            .unwrap()
            .revision,
        "rev_1"
    );
    assert_eq!(
        store
            .note_state("ws_2", "nb_shared", "note_1")
            .unwrap()
            .unwrap()
            .revision,
        "rev_2"
    );
    assert_eq!(store.enabled_notebooks("ws_1").unwrap().len(), 1);
    assert_eq!(store.enabled_notebooks("ws_2").unwrap().len(), 1);

    store.finish_sync("ws_1", "nb_shared", 42).unwrap();
    assert_eq!(
        store
            .notebook_link("ws_1", "nb_shared")
            .unwrap()
            .unwrap()
            .last_cursor,
        42
    );
    assert_eq!(
        store
            .notebook_link("ws_2", "nb_shared")
            .unwrap()
            .unwrap()
            .last_cursor,
        0
    );
}

#[test]
fn explicit_remote_link_resets_only_that_workspace_state() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store
        .set_notebook("nb_shared", "ws_1", "cloud_old", true)
        .unwrap();
    store
        .set_notebook("nb_shared", "ws_2", "cloud_other", true)
        .unwrap();
    store
        .save_note_state("ws_1", "nb_shared", "note_1", "rev_1", "hash_1")
        .unwrap();
    store
        .save_note_state("ws_2", "nb_shared", "note_1", "rev_2", "hash_2")
        .unwrap();
    store.finish_sync("ws_1", "nb_shared", 25).unwrap();

    let link = store
        .link_remote_notebook("ws_1", "nb_shared", "cloud_new")
        .unwrap();

    assert_eq!(link.cloud_notebook_id, "cloud_new");
    assert_eq!(link.last_cursor, 0);
    assert!(link.last_sync_at.is_none());
    assert!(store
        .note_state("ws_1", "nb_shared", "note_1")
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .note_state("ws_2", "nb_shared", "note_1")
            .unwrap()
            .unwrap()
            .revision,
        "rev_2"
    );
}

#[test]
fn migrates_legacy_sync_state_into_its_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("sync.db");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            r#"
                CREATE TABLE notebook_links (
                    local_notebook_id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    cloud_notebook_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    last_cursor INTEGER NOT NULL DEFAULT 0,
                    last_sync_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE note_sync_states (
                    local_notebook_id TEXT NOT NULL,
                    note_id TEXT NOT NULL,
                    revision TEXT NOT NULL,
                    last_synced_hash TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(local_notebook_id, note_id)
                );
                CREATE TABLE sync_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    local_notebook_id TEXT NOT NULL,
                    note_id TEXT NOT NULL,
                    operation TEXT NOT NULL CHECK(operation IN ('put', 'delete')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_retry_at INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    UNIQUE(local_notebook_id, note_id)
                );
                INSERT INTO notebook_links VALUES
                    ('nb_1', 'ws_legacy', 'cloud_nb_1', 1, 9, NULL, 1, 1);
                INSERT INTO note_sync_states VALUES
                    ('nb_1', 'note_1', 'rev_legacy', 'hash_legacy', 1);
                INSERT INTO sync_outbox
                    (local_notebook_id, note_id, operation, created_at)
                VALUES ('nb_1', 'note_1', 'put', 1);
                "#,
        )
        .unwrap();
    drop(connection);

    let store = SyncStore::new(&path).unwrap();
    assert_eq!(
        store
            .notebook_link("ws_legacy", "nb_1")
            .unwrap()
            .unwrap()
            .last_cursor,
        9
    );
    assert_eq!(
        store
            .note_state("ws_legacy", "nb_1", "note_1")
            .unwrap()
            .unwrap()
            .revision,
        "rev_legacy"
    );
}

#[test]
fn outbox_coalesces_latest_operation_and_clears_only_processed_entries() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store
        .set_notebook("nb_1", "ws_1", "cloud_nb_1", true)
        .unwrap();

    store
        .enqueue_outbox(
            "ws_1",
            "nb_1",
            "note_1",
            LocalChangeKind::Put,
            10,
            1,
            "device-a",
        )
        .unwrap();
    store
        .enqueue_outbox(
            "ws_1",
            "nb_1",
            "note_1",
            LocalChangeKind::Delete,
            20,
            2,
            "device-a",
        )
        .unwrap();
    store
        .enqueue_outbox(
            "ws_1",
            "nb_1",
            "note_2",
            LocalChangeKind::Put,
            30,
            3,
            "device-a",
        )
        .unwrap();

    let entries = store.outbox("ws_1", "nb_1").unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].note_id, "note_1");
    assert_eq!(entries[0].operation, LocalChangeKind::Delete);
    assert_eq!(entries[0].occurred_at, 20);
    let processed_through_id = entries[0].id;

    store
        .clear_outbox_through("ws_1", "nb_1", processed_through_id)
        .unwrap();
    let entries = store.outbox("ws_1", "nb_1").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].note_id, "note_2");
}

#[test]
fn retry_backoff_is_persisted_and_a_new_change_resets_it() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store
        .set_notebook("nb_1", "ws_1", "cloud_nb_1", true)
        .unwrap();
    store
        .enqueue_outbox(
            "ws_1",
            "nb_1",
            "note_1",
            LocalChangeKind::Put,
            10,
            1,
            "device-a",
        )
        .unwrap();

    let retry_at = store
        .defer_outbox_retry("ws_1", "nb_1", 1_000)
        .unwrap()
        .unwrap();
    assert!((6_000..=7_001).contains(&retry_at));
    assert_eq!(store.retry_due_at("ws_1", "nb_1").unwrap(), Some(retry_at));

    store
        .enqueue_outbox(
            "ws_1",
            "nb_1",
            "note_1",
            LocalChangeKind::Put,
            20,
            2,
            "device-a",
        )
        .unwrap();
    assert_eq!(store.retry_due_at("ws_1", "nb_1").unwrap(), Some(0));
}

#[test]
fn device_id_and_logical_counter_are_stable_and_monotonic() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    let first_device = store.device_id().unwrap();
    assert_eq!(first_device, store.device_id().unwrap());
    assert!(!first_device.is_empty());
    assert_eq!(store.next_logical_counter().unwrap(), 1);
    assert_eq!(store.next_logical_counter().unwrap(), 2);
    store.observe_logical_counter(10).unwrap();
    assert_eq!(store.next_logical_counter().unwrap(), 11);
}
