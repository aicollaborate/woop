//! Unit tests for the tab-window coordinator.
use super::coordinator::TabWindowCoordinator;
use super::geometry::{cascaded_window_position, point_is_in_region};
use super::registry::{TabItemDrag, WindowRegistry};
use super::resolution::{resolve_external_markdown_tab, tab_window_title};
use super::types::{TabTarget, WindowOpenTabPayload, WindowRegion, WindowTab};
use super::window::{markdown_disposition_for_source, OpenDisposition};

fn tab(id: &str) -> WindowTab {
    WindowTab {
        id: id.to_string(),
        title: id.to_string(),
        icon: None,
        target: TabTarget::Web {
            url: format!("https://example.com/{id}"),
        },
    }
}

fn tab_ids(registry: &WindowRegistry, label: &str) -> Vec<String> {
    registry
        .windows
        .iter()
        .find(|entry| entry.label == label)
        .unwrap()
        .tabs
        .iter()
        .map(|tab| tab.id.clone())
        .collect()
}

#[test]
fn registry_routes_any_tab_kind_to_the_most_recently_focused_window() {
    let mut registry = WindowRegistry::default();
    registry.add_window("tab-host-1".to_string(), tab("memo:a"));
    registry.add_window("tab-host-2".to_string(), tab("web:a"));
    registry.mark_focused("tab-host-1");
    assert_eq!(
        registry.append_to_last(tab("web:b")),
        Some(("tab-host-1".to_string(), false))
    );
    assert_eq!(registry.find_tab("web:b").unwrap().label, "tab-host-1");
}

#[test]
fn registry_routes_a_dropped_tab_to_the_explicit_host() {
    let mut registry = WindowRegistry::default();
    registry.add_window("tab-host-1".to_string(), tab("memo:a"));
    registry.add_window("tab-host-2".to_string(), tab("web:a"));
    registry.mark_focused("tab-host-2");

    assert_eq!(
        registry.append_to("tab-host-1", tab("external:a")),
        Some(("tab-host-1".to_string(), false))
    );
    assert_eq!(
        registry
            .find_tab("external:a")
            .map(|entry| entry.label.as_str()),
        Some("tab-host-1")
    );
}

#[test]
fn markdown_drop_uses_the_source_tab_host_when_available() {
    let coordinator = TabWindowCoordinator::default();
    coordinator
        .registry
        .lock()
        .unwrap()
        .add_window("tab-host-7".to_string(), tab("memo:a"));
    coordinator
        .registry
        .lock()
        .unwrap()
        .mark_ready("tab-host-7")
        .expect("mark ready");

    assert_eq!(
        markdown_disposition_for_source(&coordinator, "tab-host-7"),
        OpenDisposition::Window("tab-host-7".to_string())
    );
    assert_eq!(
        markdown_disposition_for_source(&coordinator, "main"),
        OpenDisposition::LastWindow
    );

    // 未就绪或不在 registry 中的 tab-host 降级为 LastWindow，避免错过
    // `WINDOW_OPEN_TAB_EVENT` 后的"静默吞 tab"。
    assert_eq!(
        markdown_disposition_for_source(&coordinator, "tab-host-99"),
        OpenDisposition::LastWindow
    );

    let pending = TabWindowCoordinator::default();
    pending
        .registry
        .lock()
        .unwrap()
        .add_window("tab-host-pending".to_string(), tab("memo:a"));
    assert_eq!(
        markdown_disposition_for_source(&pending, "tab-host-pending"),
        OpenDisposition::LastWindow
    );
}

#[test]
fn window_title_uses_the_first_document_title_without_markdown_extension() {
    assert_eq!(tab_window_title(&tab("Project Notes.md")), "Project Notes");
    assert_eq!(
        tab_window_title(&tab("椤圭洰璁″垝.MARKDOWN")),
        "椤圭洰璁″垝"
    );
}

#[test]
fn ready_returns_tabs_queued_during_webview_startup() {
    let mut registry = WindowRegistry::default();
    registry.add_window("tab-host-1".to_string(), tab("memo:a"));
    registry.append_to_last(tab("web:a"));
    let tabs = registry.mark_ready("tab-host-1").unwrap();
    assert_eq!(
        tabs.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
        vec!["memo:a", "web:a"]
    );
}

#[test]
fn ready_distinguishes_an_unregistered_window() {
    let mut registry = WindowRegistry::default();
    assert_eq!(registry.mark_ready("tab-host-missing"), None);
}

#[tokio::test]
async fn ready_waits_for_window_registration() {
    let coordinator = std::sync::Arc::new(TabWindowCoordinator::default());
    let waiting = {
        let coordinator = std::sync::Arc::clone(&coordinator);
        tokio::spawn(async move {
            coordinator
                .mark_window_ready_when_registered("tab-host-1")
                .await
        })
    };

    tokio::task::yield_now().await;
    coordinator
        .registry
        .lock()
        .unwrap()
        .add_window("tab-host-1".to_string(), tab("memo:a"));
    coordinator.registered_notify.notify_waiters();

    let tabs = waiting.await.unwrap().unwrap();
    assert_eq!(
        tabs.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
        vec!["memo:a"]
    );
    assert!(coordinator
        .registry
        .lock()
        .unwrap()
        .windows
        .iter()
        .find(|entry| entry.label == "tab-host-1")
        .is_some_and(|entry| entry.ready));
}

#[test]
fn closing_the_last_tab_removes_the_window() {
    let mut registry = WindowRegistry::default();
    registry.add_window("tab-host-1".to_string(), tab("memo:a"));
    registry.close_tab("tab-host-1", "memo:a");
    assert!(registry.windows.is_empty());
}

#[test]
fn reordering_a_tab_updates_only_its_window_order() {
    let mut registry = WindowRegistry::default();
    registry.add_window("tab-host-1".to_string(), tab("a"));
    registry.append_to_last(tab("b"));
    registry.append_to_last(tab("c"));

    registry.reorder_tab("tab-host-1", "c", Some("a")).unwrap();
    assert_eq!(tab_ids(&registry, "tab-host-1"), vec!["c", "a", "b"]);

    registry.reorder_tab("tab-host-1", "c", None).unwrap();
    assert_eq!(tab_ids(&registry, "tab-host-1"), vec!["a", "b", "c"]);
    assert!(registry
        .reorder_tab("tab-host-1", "c", Some("missing"))
        .is_err());
    assert_eq!(tab_ids(&registry, "tab-host-1"), vec!["a", "b", "c"]);
}

#[test]
fn tab_lookup_is_scoped_to_the_source_window() {
    let mut registry = WindowRegistry::default();
    registry.add_window("tab-host-1".to_string(), tab("memo:a"));
    registry.add_window("tab-host-2".to_string(), tab("web:a"));

    assert_eq!(
        registry
            .tab_in_window("tab-host-2", "web:a")
            .map(|tab| tab.id),
        Some("web:a".to_string())
    );
    assert!(registry.tab_in_window("tab-host-1", "web:a").is_none());
}

#[test]
fn moving_a_tab_removes_an_empty_source() {
    let mut registry = WindowRegistry::default();
    registry.add_window("tab-host-1".to_string(), tab("memo:a"));
    registry.add_window("tab-host-2".to_string(), tab("memo:b"));
    registry.mark_ready("tab-host-2").unwrap();

    let refreshed = WindowTab {
        title: "renamed.md".to_string(),
        ..tab("memo:a")
    };
    let (moved, ready, rollback) = registry
        .move_tab("tab-host-1", "memo:a", "tab-host-2", refreshed)
        .unwrap();

    assert_eq!(moved.id, "memo:a");
    assert_eq!(moved.title, "renamed.md");
    assert!(ready);
    assert!(registry
        .windows
        .iter()
        .all(|entry| entry.label != "tab-host-1"));
    assert_eq!(
        registry
            .windows
            .iter()
            .find(|entry| entry.label == "tab-host-2")
            .unwrap()
            .tabs
            .iter()
            .map(|tab| tab.id.as_str())
            .collect::<Vec<_>>(),
        vec!["memo:b", "memo:a"]
    );

    registry.rollback_move(rollback);
    assert_eq!(
        registry
            .tab_in_window("tab-host-1", "memo:a")
            .map(|tab| tab.title),
        Some("renamed.md".to_string())
    );
    assert!(registry.tab_in_window("tab-host-2", "memo:a").is_none());
}

#[test]
fn drag_hit_test_accepts_only_the_registered_tab_region() {
    let position = tauri::PhysicalPosition::new(100, 200);
    let region = WindowRegion {
        x: 90.0,
        y: 8.0,
        width: 600.0,
        height: 32.0,
    };
    assert!(point_is_in_region(
        tauri::PhysicalPosition::new(280, 216),
        position,
        2.0,
        region,
    ));
    assert!(point_is_in_region(
        tauri::PhysicalPosition::new(1480, 280),
        position,
        2.0,
        region,
    ));
    assert!(!point_is_in_region(
        tauri::PhysicalPosition::new(279, 240),
        position,
        2.0,
        region,
    ));
    assert!(!point_is_in_region(
        tauri::PhysicalPosition::new(500, 281),
        position,
        2.0,
        region,
    ));
}

#[test]
fn tab_item_drag_session_is_scoped_by_source_tab_and_drag_id() {
    let drag = TabItemDrag {
        source_label: "tab-host-1".to_string(),
        tab_id: "memo:a".to_string(),
        drag_id: "drag-1".to_string(),
        hovered_target: None,
    };
    assert!(drag.matches("tab-host-1", "memo:a", "drag-1"));
    assert!(!drag.matches("tab-host-2", "memo:a", "drag-1"));
    assert!(!drag.matches("tab-host-1", "memo:b", "drag-1"));
    assert!(!drag.matches("tab-host-1", "memo:a", "drag-2"));
}

#[test]
fn cascade_position_stays_inside_the_monitor() {
    assert_eq!(
        cascaded_window_position((1600, 900), (900, 680), (0, 0), (1920, 1080), 7),
        (796, 176)
    );
}

#[test]
fn tab_protocol_serializes_as_the_frontend_discriminated_union() {
    let memo_tab = WindowTab {
        id: "memo:a".to_string(),
        title: "A.md".to_string(),
        icon: None,
        target: TabTarget::Memo {
            memo_id: "a".to_string(),
            notebook_id: "notebook".to_string(),
            notebook_path: "/notebook".to_string(),
            file_path: "/notebook/A.md".to_string(),
        },
    };
    let value = serde_json::to_value(&memo_tab).unwrap();
    assert_eq!(value["id"], "memo:a");
    assert_eq!(value["target"]["kind"], "memo");
    assert_eq!(value["target"]["memoId"], "a");
    assert_eq!(value["target"]["filePath"], "/notebook/A.md");

    let external_tab = WindowTab {
        id: "external:/tmp/Outside.md".to_string(),
        title: "Outside.md".to_string(),
        icon: None,
        target: TabTarget::ExternalMarkdown {
            file_path: "/tmp/Outside.md".to_string(),
        },
    };
    let external_value = serde_json::to_value(external_tab).unwrap();
    assert_eq!(external_value["target"]["kind"], "external_markdown");
    assert_eq!(external_value["target"]["filePath"], "/tmp/Outside.md");

    let delivery = serde_json::to_value(WindowOpenTabPayload {
        tab: memo_tab,
        transfer_id: Some("tab-transfer-1".to_string()),
        target_label: "tab-host-2".to_string(),
    })
    .unwrap();
    assert_eq!(delivery["tab"]["id"], "memo:a");
    assert_eq!(delivery["transferId"], "tab-transfer-1");
    assert_eq!(delivery["targetLabel"], "tab-host-2");
}

#[test]
fn external_markdown_tab_uses_canonical_path_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Outside.md");
    std::fs::write(&path, "# Outside").unwrap();

    let tab = resolve_external_markdown_tab(path.to_string_lossy().as_ref()).unwrap();
    let canonical = dunce::canonicalize(path)
        .unwrap()
        .to_string_lossy()
        .to_string();
    assert_eq!(tab.id, format!("external:{canonical}"));
    assert_eq!(tab.title, "Outside.md");
    assert_eq!(
        tab.target,
        TabTarget::ExternalMarkdown {
            file_path: canonical,
        }
    );
}
