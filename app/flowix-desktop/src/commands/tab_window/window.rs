//! Window lifecycle and routing.
use super::coordinator::TabWindowCoordinator;
use super::geometry::cascade_window;
use super::registry::MoveRollback;
use super::resolution::{resolve_markdown_path_tab, tab_window_title};
use super::types::{WindowOpenTabPayload, WindowPosition, WindowTab, WINDOW_OPEN_TAB_EVENT};
use crate::app::state::AppState;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum OpenDisposition {
    NewWindow,
    LastWindow,
    Window(String),
}

pub(super) enum DetachOperation {
    Cancelled,
    NewWindow {
        label: String,
    },
    Merge {
        target_label: String,
        tab: WindowTab,
        ready: bool,
        rollback: MoveRollback,
    },
}

pub fn route_markdown_path_tab(
    app: &tauri::AppHandle,
    state: &AppState,
    coordinator: &TabWindowCoordinator,
    file_path: &str,
) -> Result<(), String> {
    route_tab(
        app,
        coordinator,
        resolve_markdown_path_tab(file_path, state)?,
        OpenDisposition::LastWindow,
    )
}

pub(super) fn markdown_disposition_for_source(
    coordinator: &TabWindowCoordinator,
    window_label: &str,
) -> OpenDisposition {
    if !window_label.starts_with("tab-host-") {
        return OpenDisposition::LastWindow;
    }
    let registry = match coordinator.registry.lock() {
        Ok(registry) => registry,
        Err(_) => return OpenDisposition::LastWindow,
    };
    if registry
        .windows
        .iter()
        .any(|entry| entry.label == window_label && entry.ready)
    {
        OpenDisposition::Window(window_label.to_string())
    } else {
        OpenDisposition::LastWindow
    }
}

pub(super) fn create_window(
    app: &tauri::AppHandle,
    coordinator: &TabWindowCoordinator,
    tab: WindowTab,
    position: Option<WindowPosition>,
) -> Result<String, String> {
    use tauri::WebviewWindowBuilder;

    let label = coordinator.next_label();
    let title = tab_window_title(&tab).to_string();
    let builder = WebviewWindowBuilder::new(
        app,
        label.clone(),
        tauri::WebviewUrl::App("index.html#tab-window".into()),
    )
    .title(title)
    .inner_size(900.0, 680.0)
    .min_inner_size(420.0, 520.0)
    .devtools(cfg!(debug_assertions));

    let builder = match position {
        Some(position) => builder.position(position.x, position.y),
        None => builder.center(),
    };

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            18.0, 25.0,
        )));
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);

    let window = builder.build().map_err(|e| e.to_string())?;
    coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?
        .add_window(label.clone(), tab);
    coordinator.registered_notify.notify_waiters();
    crate::window_chrome::apply_window_border_color(&window);
    // 鏂扮獥鍙ｅ嵆鍒诲榻愪富棰樿儗鏅壊 (涓庝富绐楀彛鍚姩涓€鑷?, 閬垮厤鍐峰惎鍔ㄧ櫧闂€?
    let theme = app.state::<AppState>().user_config.get_preference().theme;
    crate::window_chrome::apply_theme_background(&window, theme);
    if position.is_none() {
        cascade_window(app, &window, coordinator);
    }

    let app_handle = app.clone();
    let event_label = label.clone();
    window.on_window_event(move |event| {
        let coordinator = app_handle.state::<TabWindowCoordinator>();
        match event {
            tauri::WindowEvent::Destroyed => {
                if let Some(watches) = app_handle
                    .try_state::<crate::commands::external_document_watch::ExternalDocumentWatchState>()
                {
                    watches.release_window(&event_label);
                }
                coordinator.release_window_state(&app_handle, &event_label);
                if let Ok(mut registry) = coordinator.registry.lock() {
                    registry.close_window(&event_label);
                };
            }
            tauri::WindowEvent::Focused(true) => {
                if let Ok(mut registry) = coordinator.registry.lock() {
                    registry.mark_focused(&event_label);
                }
            }
            _ => {}
        }
    });
    Ok(label)
}

pub(super) fn route_tab(
    app: &tauri::AppHandle,
    coordinator: &TabWindowCoordinator,
    tab: WindowTab,
    disposition: OpenDisposition,
) -> Result<(), String> {
    let _open_guard = coordinator
        .open_lock
        .lock()
        .map_err(|_| "tab window open lock poisoned".to_string())?;
    let mut registry = coordinator
        .registry
        .lock()
        .map_err(|_| "tab window registry lock poisoned".to_string())?;
    registry.prune(app);

    let target = registry
        .find_tab(&tab.id)
        .map(|entry| (entry.label.clone(), entry.ready))
        .or_else(|| match disposition {
            OpenDisposition::LastWindow => registry.append_to_last(tab.clone()),
            OpenDisposition::Window(label) => registry.append_to(&label, tab.clone()),
            OpenDisposition::NewWindow => None,
        });

    let Some((label, ready)) = target else {
        drop(registry);
        create_window(app, coordinator, tab, None)?;
        return Ok(());
    };
    drop(registry);

    let Some(window) = app.get_webview_window(&label) else {
        return Err("registered tab window is unavailable".to_string());
    };
    window.unminimize().ok();
    window.set_focus().ok();
    if ready {
        app.emit_to(
            tauri::EventTarget::webview_window(&label),
            WINDOW_OPEN_TAB_EVENT,
            WindowOpenTabPayload {
                tab,
                transfer_id: None,
                target_label: label.clone(),
            },
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
