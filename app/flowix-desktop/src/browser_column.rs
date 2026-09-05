//! Native events for BrowserColumn's external webviews.
//!
//! Tauri's JavaScript `Webview` wrapper can create and size a child webview,
//! but it does not expose the native navigation/page-load hooks. Registering a
//! small host plugin keeps the durable BrowserColumn tab model synchronized
//! when a user follows a link inside a remote page.

use serde::Serialize;
use tauri::{plugin::Builder, plugin::TauriPlugin, webview::PageLoadEvent, Emitter, Runtime};

pub const NAVIGATION_EVENT: &str = "flowix-browser-column-navigation";
const BROWSER_WEBVIEW_PREFIX: &str = "browser-column-webpage-";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserColumnNavigationEvent {
    webview_label: String,
    url: String,
    phase: &'static str,
}

fn is_browser_webview(label: &str) -> bool {
    label.starts_with(BROWSER_WEBVIEW_PREFIX)
}

fn emit_navigation<R: Runtime>(webview: &tauri::Webview<R>, url: &str, phase: &'static str) {
    let payload = BrowserColumnNavigationEvent {
        webview_label: webview.label().to_string(),
        url: url.to_string(),
        phase,
    };
    // The host webview is always the `main` window. Emitting to that label is
    // important: emitting from the child webview would only notify the remote
    // page, not the React store that owns the tab model.
    if let Err(error) = webview.emit_to("main", NAVIGATION_EVENT, payload) {
        tracing::debug!(webview = %webview.label(), %error, "browser-column navigation event was not delivered");
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("browser-column")
        .on_navigation(|webview, url| {
            if is_browser_webview(webview.label()) {
                emit_navigation(webview, url.as_str(), "navigating");
            }
            true
        })
        .on_page_load(|webview, payload| {
            if !is_browser_webview(webview.label()) {
                return;
            }
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            emit_navigation(webview, payload.url().as_str(), phase);
        })
        .build()
}
