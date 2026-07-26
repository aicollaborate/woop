//! Shared types, IPC payloads, and timing/event constants.
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const WINDOW_OPEN_TAB_EVENT: &str = "flowix:window-open-tab";
pub const WINDOW_MERGE_HOVER_EVENT: &str = "flowix:window-merge-hover";
pub const WINDOW_ROLLBACK_TAB_EVENT: &str = "flowix:window-rollback-tab";
pub const WINDOW_TAB_DRAG_POINTER_EVENT: &str = "flowix:window-tab-drag-pointer";
pub(super) const WINDOW_CASCADE_OFFSET: i32 = 32;
pub(super) const WINDOW_CASCADE_SLOTS: usize = 8;
pub(super) const TAB_DRAG_HOVER_POLL_INTERVAL: Duration = Duration::from_millis(24);
pub(super) const TAB_TRANSFER_ACK_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const TAB_WINDOW_READY_TIMEOUT: Duration = Duration::from_secs(8);
pub(super) const TAB_WINDOW_REGISTRATION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TabTarget {
    Memo {
        memo_id: String,
        notebook_id: String,
        notebook_path: String,
        file_path: String,
    },
    ExternalMarkdown {
        file_path: String,
    },
    Web {
        url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowTab {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub target: TabTarget,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPosition {
    pub(super) x: f64,
    pub(super) y: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRegion {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabDragResult {
    pub(super) merged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MergeHoverPayload {
    pub(super) active: bool,
    pub(super) tab: Option<WindowTab>,
    pub(super) target_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowOpenTabPayload {
    pub(super) tab: WindowTab,
    pub(super) transfer_id: Option<String>,
    pub(super) target_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowRollbackTabPayload {
    pub(super) tab_id: String,
    pub(super) transfer_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TabDragPointerPayload {
    pub(super) drag_id: String,
    pub(super) screen_x: f64,
}
