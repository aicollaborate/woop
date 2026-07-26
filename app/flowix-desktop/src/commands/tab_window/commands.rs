//! Thin #[tauri::command] wrappers.
use super::coordinator::TabWindowCoordinator;
use super::geometry::{cursor_physical_position, find_header_target};
use super::ipc_events::{
    clear_merge_hover, deliver_merged_tab, emit_tab_drag_pointer, emit_transfer_rollback,
};
use super::registry::TabItemDrag;
use super::resolution::{
    refresh_tab, resolve_external_markdown_tab, resolve_markdown_path_tab, resolve_memo_tab,
};
use super::types::{
    TabDragResult, WindowPosition, WindowRegion, WindowTab, TAB_DRAG_HOVER_POLL_INTERVAL,
};
use super::window::{
    create_window, markdown_disposition_for_source, route_tab, DetachOperation, OpenDisposition,
};
use crate::app::state::AppState;
use tauri::Manager;

#[tauri::command]
pub async fn open_note_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    memo_id: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_memo_tab(&memo_id, state.inner())?,
        OpenDisposition::NewWindow,
    )
}

#[tauri::command]
pub async fn open_note_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    memo_id: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_memo_tab(&memo_id, state.inner())?,
        OpenDisposition::LastWindow,
    )
}

#[tauri::command]
pub async fn open_external_markdown_window(
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    file_path: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_external_markdown_tab(&file_path)?,
        OpenDisposition::NewWindow,
    )
}

#[tauri::command]
pub async fn open_external_markdown_tab(
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    file_path: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_external_markdown_tab(&file_path)?,
        OpenDisposition::LastWindow,
    )
}

#[tauri::command]
pub async fn open_markdown_path_tab(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    file_path: String,
) -> Result<(), String> {
    route_tab(
        &app,
        coordinator.inner(),
        resolve_markdown_path_tab(&file_path, state.inner())?,
        markdown_disposition_for_source(coordinator.inner(), window.label()),
    )
}

#[tauri::command]
pub async fn tab_window_ready(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
) -> Result<Vec<WindowTab>, String> {
    let tabs = coordinator
        .mark_window_ready_when_registered(window.label())
        .await?;
    coordinator.ready_notify.notify_waiters();
    Ok(tabs)
}

#[tauri::command]
pub fn tab_window_ack_transfer(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    transfer_id: String,
    tab_id: String,
) -> Result<(), String> {
    let expected_transfer = coordinator
        .pending_transfers
        .lock()
        .map_err(|_| "pending tab transfer lock poisoned".to_string())?
        .get(&transfer_id)
        .cloned();
    if expected_transfer.as_ref() != Some(&(window.label().to_string(), tab_id.clone())) {
        return Err("tab transfer is unavailable".to_string());
    }
    coordinator
        .transfer_acks
        .lock()
        .map_err(|_| "tab transfer acknowledgement lock poisoned".to_string())?
        .insert(transfer_id);
    coordinator.transfer_notify.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn tab_window_set_tab_region(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    region: WindowRegion,
) -> Result<(), String> {
    coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?
        .set_tab_region(window.label(), region)
}

#[tauri::command]
pub fn tab_window_close_tab(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
) -> Result<(), String> {
    let mut registry = coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?;
    registry.close_tab(window.label(), &tab_id);
    Ok(())
}

#[tauri::command]
pub fn tab_window_reorder_tab(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
    before_tab_id: Option<String>,
) -> Result<(), String> {
    coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?
        .reorder_tab(window.label(), &tab_id, before_tab_id.as_deref())
}

#[tauri::command]
pub fn tab_window_begin_tab_item_drag(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
    drag_id: String,
) -> Result<(), String> {
    {
        let registry = coordinator
            .registry
            .lock()
            .map_err(|_| "tab window registry lock poisoned".to_string())?;
        if registry.tab_in_window(window.label(), &tab_id).is_none() {
            return Err(format!("tab is not registered in source window: {tab_id}"));
        }
    }
    let source_label = window.label().to_string();
    let next = TabItemDrag {
        source_label: source_label.clone(),
        tab_id: tab_id.clone(),
        drag_id: drag_id.clone(),
        hovered_target: None,
    };
    let previous = coordinator
        .tab_item_drag
        .lock()
        .map_err(|_| "tab item drag lock poisoned".to_string())?
        .replace(next);
    if let Some(previous) = previous {
        clear_merge_hover(&app, previous.hovered_target.as_deref());
    }
    if let Ok(point) = cursor_physical_position(&app) {
        emit_tab_drag_pointer(&app, &source_label, &drag_id, point);
        coordinator.update_tab_item_drag_hover(&app, &source_label, &tab_id, &drag_id, point);
    }

    // HTML drag events are not delivered consistently after the cursor leaves
    // a WebView (notably on macOS). Polling the OS cursor from the backend keeps
    // hover detection ordered and independent from either WebView's event loop.
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TAB_DRAG_HOVER_POLL_INTERVAL).await;
            let coordinator = app.state::<TabWindowCoordinator>();
            if !coordinator.tab_item_drag_is_active(&source_label, &tab_id, &drag_id) {
                break;
            }
            let Ok(point) = cursor_physical_position(&app) else {
                continue;
            };
            emit_tab_drag_pointer(&app, &source_label, &drag_id, point);
            if !coordinator.update_tab_item_drag_hover(
                &app,
                &source_label,
                &tab_id,
                &drag_id,
                point,
            ) {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn tab_window_cancel_tab_item_drag(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
    drag_id: String,
) -> Result<(), String> {
    let cancelled = {
        let mut drag = coordinator
            .tab_item_drag
            .lock()
            .map_err(|_| "tab item drag lock poisoned".to_string())?;
        if drag
            .as_ref()
            .is_some_and(|session| session.matches(window.label(), &tab_id, &drag_id))
        {
            drag.take()
        } else {
            None
        }
    };
    if let Some(cancelled) = cancelled {
        clear_merge_hover(&app, cancelled.hovered_target.as_deref());
    }
    Ok(())
}

/// Moves a tab to another host or tears it off into a host window.
/// A single-tab source is merged only when dropped on another host; otherwise
/// the operation is cancelled and its existing window remains unchanged.
#[tauri::command]
pub async fn tab_window_detach_tab(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    coordinator: tauri::State<'_, TabWindowCoordinator>,
    tab_id: String,
    position: WindowPosition,
    drag_id: String,
) -> Result<TabDragResult, String> {
    // Read the authoritative OS cursor before consuming the session. A
    // transient platform error then leaves the drag cancellable/retryable.
    let drop_point = cursor_physical_position(&app)?;
    let item_drag = {
        let mut drag = coordinator
            .tab_item_drag
            .lock()
            .map_err(|_| "tab item drag lock poisoned".to_string())?;
        if drag
            .as_ref()
            .is_some_and(|session| session.matches(window.label(), &tab_id, &drag_id))
        {
            drag.take()
        } else {
            None
        }
    }
    .ok_or_else(|| "tab item drag session is unavailable".to_string())?;

    let source_label = window.label().to_string();
    let registered_tab = coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?
        .tab_in_window(&source_label, &tab_id)
        .ok_or_else(|| format!("tab is not registered in source window: {tab_id}"))?;
    let refreshed_tab = refresh_tab(&registered_tab, state.inner())?;
    let operation = (|| -> Result<DetachOperation, String> {
        let _open_guard = coordinator
            .open_lock
            .lock()
            .map_err(|_| "tab window open lock poisoned".to_string())?;
        let mut registry = coordinator
            .registry
            .lock()
            .map_err(|_| "tab window registry lock poisoned".to_string())?;
        registry.prune(&app);

        if registry.tab_in_window(&source_label, &tab_id).is_none() {
            return Err(format!("tab is not registered in source window: {tab_id}"));
        }
        let source_has_only_tab = registry
            .windows
            .iter()
            .find(|entry| entry.label == source_label)
            .is_some_and(|entry| entry.tabs.len() == 1);
        if let Some(target_label) = find_header_target(&app, &registry, &source_label, drop_point) {
            let (tab, ready, rollback) =
                registry.move_tab(&source_label, &tab_id, &target_label, refreshed_tab.clone())?;
            return Ok(DetachOperation::Merge {
                target_label,
                tab,
                ready,
                rollback,
            });
        }

        if source_has_only_tab {
            return Ok(DetachOperation::Cancelled);
        }

        drop(registry);
        let label = create_window(
            &app,
            coordinator.inner(),
            refreshed_tab.clone(),
            Some(position),
        )?;
        Ok(DetachOperation::NewWindow { label })
    })();
    clear_merge_hover(&app, item_drag.hovered_target.as_deref());
    match operation? {
        DetachOperation::Cancelled => Ok(TabDragResult { merged: false }),
        DetachOperation::NewWindow { label } => {
            if !coordinator.wait_for_window_ready(&label).await {
                if let Ok(mut registry) = coordinator.registry.lock() {
                    registry.close_window(&label);
                }
                if let Some(created) = app.get_webview_window(&label) {
                    created.destroy().ok();
                }
                return Err("new tab window did not become ready".to_string());
            }
            let _open_guard = coordinator
                .open_lock
                .lock()
                .map_err(|_| "tab window open lock poisoned".to_string())?;
            coordinator
                .registry
                .lock()
                .map_err(|_| "tab window registry lock poisoned".to_string())?
                .close_tab(&source_label, &tab_id);
            Ok(TabDragResult { merged: false })
        }
        DetachOperation::Merge {
            target_label,
            tab,
            ready,
            rollback,
        } => {
            if !ready {
                coordinator
                    .registry
                    .lock()
                    .map_err(|_| "tab window registry lock poisoned".to_string())?
                    .rollback_move(rollback);
                return Err("target tab window is not ready".to_string());
            }
            let transfer_id = coordinator.next_transfer_id();
            coordinator
                .pending_transfers
                .lock()
                .map_err(|_| "pending tab transfer lock poisoned".to_string())?
                .insert(transfer_id.clone(), (target_label.clone(), tab.id.clone()));
            if let Err(err) = deliver_merged_tab(&app, &target_label, &tab, ready, &transfer_id) {
                if let Ok(mut pending) = coordinator.pending_transfers.lock() {
                    pending.remove(&transfer_id);
                }
                coordinator
                    .registry
                    .lock()
                    .map_err(|_| "tab window registry lock poisoned".to_string())?
                    .rollback_move(rollback);
                emit_transfer_rollback(&app, &target_label, &tab.id, &transfer_id);
                return Err(err);
            }
            if !coordinator.wait_for_transfer_ack(&transfer_id).await {
                coordinator
                    .registry
                    .lock()
                    .map_err(|_| "tab window registry lock poisoned".to_string())?
                    .rollback_move(rollback);
                emit_transfer_rollback(&app, &target_label, &tab.id, &transfer_id);
                return Err("target tab window did not acknowledge the transfer".to_string());
            }
            Ok(TabDragResult { merged: true })
        }
    }
}
