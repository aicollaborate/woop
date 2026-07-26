//! Tauri emit-only helpers.
use super::types::{
    MergeHoverPayload, TabDragPointerPayload, WindowOpenTabPayload, WindowRollbackTabPayload,
    WindowTab, WINDOW_MERGE_HOVER_EVENT, WINDOW_OPEN_TAB_EVENT, WINDOW_ROLLBACK_TAB_EVENT,
    WINDOW_TAB_DRAG_POINTER_EVENT,
};
use tauri::{Emitter, Manager};

pub(super) fn emit_tab_drag_pointer(
    app: &tauri::AppHandle,
    source_label: &str,
    drag_id: &str,
    point: tauri::PhysicalPosition<i32>,
) {
    let Some(window) = app.get_webview_window(source_label) else {
        return;
    };
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    app.emit_to(
        tauri::EventTarget::webview_window(source_label),
        WINDOW_TAB_DRAG_POINTER_EVENT,
        TabDragPointerPayload {
            drag_id: drag_id.to_string(),
            screen_x: f64::from(point.x) / scale_factor,
        },
    )
    .ok();
}

pub(super) fn emit_transfer_rollback(
    app: &tauri::AppHandle,
    target_label: &str,
    tab_id: &str,
    transfer_id: &str,
) {
    if app.get_webview_window(target_label).is_none() {
        return;
    }
    app.emit_to(
        tauri::EventTarget::webview_window(target_label),
        WINDOW_ROLLBACK_TAB_EVENT,
        WindowRollbackTabPayload {
            tab_id: tab_id.to_string(),
            transfer_id: transfer_id.to_string(),
        },
    )
    .ok();
}

pub(super) fn emit_merge_hover(
    app: &tauri::AppHandle,
    label: &str,
    active: bool,
    tab: Option<WindowTab>,
) {
    if app.get_webview_window(label).is_none() {
        return;
    }
    app.emit_to(
        tauri::EventTarget::webview_window(label),
        WINDOW_MERGE_HOVER_EVENT,
        MergeHoverPayload {
            active,
            tab,
            target_label: label.to_string(),
        },
    )
    .ok();
}

pub(super) fn clear_merge_hover(app: &tauri::AppHandle, target_label: Option<&str>) {
    if let Some(label) = target_label {
        emit_merge_hover(app, label, false, None);
    }
}

pub(super) fn deliver_merged_tab(
    app: &tauri::AppHandle,
    target_label: &str,
    tab: &WindowTab,
    ready: bool,
    transfer_id: &str,
) -> Result<(), String> {
    let window = app
        .get_webview_window(target_label)
        .ok_or_else(|| "target tab window is unavailable".to_string())?;
    window.unminimize().ok();
    window.set_focus().ok();
    if ready {
        app.emit_to(
            tauri::EventTarget::webview_window(target_label),
            WINDOW_OPEN_TAB_EVENT,
            WindowOpenTabPayload {
                tab: tab.clone(),
                transfer_id: Some(transfer_id.to_string()),
                target_label: target_label.to_string(),
            },
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}
