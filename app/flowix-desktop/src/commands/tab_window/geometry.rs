//! Pure geometry: cursor, hit-test, header target, cascade placement.
use super::coordinator::TabWindowCoordinator;
use super::registry::WindowRegistry;
use super::types::{WindowRegion, WINDOW_CASCADE_OFFSET, WINDOW_CASCADE_SLOTS};
use std::sync::atomic::Ordering;
use tauri::Manager;

pub(super) fn cursor_physical_position(
    app: &tauri::AppHandle,
) -> Result<tauri::PhysicalPosition<i32>, String> {
    app.cursor_position()
        .map(|position| {
            tauri::PhysicalPosition::new(position.x.round() as i32, position.y.round() as i32)
        })
        .map_err(|err| err.to_string())
}

pub(super) fn point_is_in_region(
    point: tauri::PhysicalPosition<i32>,
    window_position: tauri::PhysicalPosition<i32>,
    scale: f64,
    region: WindowRegion,
) -> bool {
    let left = window_position
        .x
        .saturating_add((region.x * scale).round() as i32);
    let top = window_position
        .y
        .saturating_add((region.y * scale).round() as i32);
    let right = left.saturating_add((region.width * scale).round() as i32);
    let bottom = top.saturating_add((region.height * scale).round() as i32);
    point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
}

pub(super) fn find_header_target(
    app: &tauri::AppHandle,
    registry: &WindowRegistry,
    source_label: &str,
    point: tauri::PhysicalPosition<i32>,
) -> Option<String> {
    registry.windows.iter().rev().find_map(|entry| {
        if entry.label == source_label {
            return None;
        }
        let window = app.get_webview_window(&entry.label)?;
        let position = window.outer_position().ok()?;
        let scale = window.scale_factor().ok()?;
        let region = entry.tab_region?;
        point_is_in_region(point, position, scale, region).then(|| entry.label.clone())
    })
}

pub(super) fn cascade_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    coordinator: &TabWindowCoordinator,
) {
    let Some(main_window) = app.get_webview_window("main") else {
        return;
    };
    let (Ok(anchor), Ok(window_size), Ok(Some(monitor))) = (
        main_window.outer_position(),
        window.outer_size(),
        main_window.current_monitor(),
    ) else {
        return;
    };
    let index = coordinator.cascade_index.fetch_add(1, Ordering::Relaxed) % WINDOW_CASCADE_SLOTS;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let (x, y) = cascaded_window_position(
        (anchor.x, anchor.y),
        (window_size.width, window_size.height),
        (monitor_position.x, monitor_position.y),
        (monitor_size.width, monitor_size.height),
        index,
    );
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )))
        .ok();
}

pub(super) fn cascaded_window_position(
    anchor: (i32, i32),
    window_size: (u32, u32),
    monitor_origin: (i32, i32),
    monitor_size: (u32, u32),
    cascade_index: usize,
) -> (i32, i32) {
    let monitor_width = monitor_size.0.min(i32::MAX as u32) as i32;
    let monitor_height = monitor_size.1.min(i32::MAX as u32) as i32;
    let window_width = window_size.0.min(i32::MAX as u32) as i32;
    let window_height = window_size.1.min(i32::MAX as u32) as i32;
    let max_x = monitor_origin
        .0
        .saturating_add(monitor_width)
        .saturating_sub(window_width)
        .max(monitor_origin.0);
    let max_y = monitor_origin
        .1
        .saturating_add(monitor_height)
        .saturating_sub(window_height)
        .max(monitor_origin.1);
    let base_x = anchor.0.saturating_add(64).clamp(monitor_origin.0, max_x);
    let base_y = anchor.1.saturating_add(64).clamp(monitor_origin.1, max_y);
    let offset = WINDOW_CASCADE_OFFSET * cascade_index as i32;
    let axis = |base: i32, min: i32, max: i32| {
        let forward = base.saturating_add(offset);
        if forward <= max {
            forward
        } else {
            base.saturating_sub(offset).clamp(min, max)
        }
    };
    (
        axis(base_x, monitor_origin.0, max_x),
        axis(base_y, monitor_origin.1, max_y),
    )
}
