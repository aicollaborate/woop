//! TabWindowCoordinator -- single stateful facade managed as tauri::State.
use super::geometry::find_header_target;
use super::ipc_events::{clear_merge_hover, emit_merge_hover};
use super::registry::{TabItemDrag, WindowRegistry};
use super::types::{
    WindowTab, TAB_TRANSFER_ACK_TIMEOUT, TAB_WINDOW_READY_TIMEOUT, TAB_WINDOW_REGISTRATION_TIMEOUT,
};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub struct TabWindowCoordinator {
    pub(super) registry: Mutex<WindowRegistry>,
    pub(super) open_lock: Mutex<()>,
    pub(super) next_label: AtomicUsize,
    pub(super) cascade_index: AtomicUsize,
    pub(super) tab_item_drag: Mutex<Option<TabItemDrag>>,
    pub(super) next_transfer: AtomicUsize,
    pub(super) pending_transfers: Mutex<HashMap<String, (String, String)>>,
    pub(super) transfer_acks: Mutex<HashSet<String>>,
    pub(super) transfer_notify: tokio::sync::Notify,
    pub(super) registered_notify: tokio::sync::Notify,
    pub(super) ready_notify: tokio::sync::Notify,
}

impl Default for TabWindowCoordinator {
    fn default() -> Self {
        Self {
            registry: Mutex::new(WindowRegistry::default()),
            open_lock: Mutex::new(()),
            next_label: AtomicUsize::new(0),
            cascade_index: AtomicUsize::new(0),
            tab_item_drag: Mutex::new(None),
            next_transfer: AtomicUsize::new(0),
            pending_transfers: Mutex::new(HashMap::new()),
            transfer_acks: Mutex::new(HashSet::new()),
            transfer_notify: tokio::sync::Notify::new(),
            registered_notify: tokio::sync::Notify::new(),
            ready_notify: tokio::sync::Notify::new(),
        }
    }
}

impl TabWindowCoordinator {
    pub(super) fn next_label(&self) -> String {
        format!(
            "tab-host-{}",
            self.next_label.fetch_add(1, Ordering::Relaxed)
        )
    }

    pub(super) fn next_transfer_id(&self) -> String {
        format!(
            "tab-transfer-{}",
            self.next_transfer.fetch_add(1, Ordering::Relaxed)
        )
    }

    pub(super) async fn wait_for_transfer_ack(&self, transfer_id: &str) -> bool {
        let wait = async {
            loop {
                let notified = self.transfer_notify.notified();
                if self
                    .transfer_acks
                    .lock()
                    .is_ok_and(|acks| acks.contains(transfer_id))
                {
                    return true;
                }
                if self
                    .pending_transfers
                    .lock()
                    .is_ok_and(|pending| !pending.contains_key(transfer_id))
                {
                    return false;
                }
                notified.await;
            }
        };
        let acknowledged = tokio::time::timeout(TAB_TRANSFER_ACK_TIMEOUT, wait)
            .await
            .is_ok_and(|value| value);
        if let Ok(mut acks) = self.transfer_acks.lock() {
            acks.remove(transfer_id);
        }
        if let Ok(mut pending) = self.pending_transfers.lock() {
            pending.remove(transfer_id);
        }
        acknowledged
    }

    pub(super) fn release_window_state(&self, app: &tauri::AppHandle, label: &str) {
        let cancelled_drag = self.tab_item_drag.lock().ok().and_then(|mut drag| {
            if drag.as_ref().is_some_and(|session| {
                session.source_label == label || session.hovered_target.as_deref() == Some(label)
            }) {
                drag.take()
            } else {
                None
            }
        });
        if let Some(cancelled_drag) = cancelled_drag {
            clear_merge_hover(app, cancelled_drag.hovered_target.as_deref());
        }

        let removed_transfers = self
            .pending_transfers
            .lock()
            .map(|mut pending| {
                let ids = pending
                    .iter()
                    .filter(|(_, (target_label, _))| target_label == label)
                    .map(|(transfer_id, _)| transfer_id.clone())
                    .collect::<Vec<_>>();
                pending.retain(|_, (target_label, _)| target_label != label);
                ids
            })
            .unwrap_or_default();
        if !removed_transfers.is_empty() {
            if let Ok(mut acknowledgements) = self.transfer_acks.lock() {
                for transfer_id in removed_transfers {
                    acknowledgements.remove(&transfer_id);
                }
            }
            self.transfer_notify.notify_waiters();
        }
        self.ready_notify.notify_waiters();
    }

    pub(super) async fn wait_for_window_ready(&self, label: &str) -> bool {
        let wait = async {
            loop {
                let notified = self.ready_notify.notified();
                if let Ok(registry) = self.registry.lock() {
                    match registry.windows.iter().find(|entry| entry.label == label) {
                        Some(entry) if entry.ready => return true,
                        None => return false,
                        _ => {}
                    }
                }
                notified.await;
            }
        };
        tokio::time::timeout(TAB_WINDOW_READY_TIMEOUT, wait)
            .await
            .is_ok_and(|value| value)
    }

    pub(super) async fn mark_window_ready_when_registered(
        &self,
        label: &str,
    ) -> Result<Vec<WindowTab>, String> {
        let wait = async {
            loop {
                let notified = self.registered_notify.notified();
                let tabs = self
                    .registry
                    .lock()
                    .map_err(|_| "tab window registry lock poisoned".to_string())?
                    .mark_ready(label);
                if let Some(tabs) = tabs {
                    return Ok(tabs);
                }
                notified.await;
            }
        };
        tokio::time::timeout(TAB_WINDOW_REGISTRATION_TIMEOUT, wait)
            .await
            .map_err(|_| format!("tab window was not registered before ready timeout: {label}"))?
    }

    pub(super) fn tab_item_drag_is_active(
        &self,
        source_label: &str,
        tab_id: &str,
        drag_id: &str,
    ) -> bool {
        self.tab_item_drag
            .lock()
            .ok()
            .and_then(|drag| {
                drag.as_ref()
                    .map(|session| session.matches(source_label, tab_id, drag_id))
            })
            .unwrap_or(false)
    }

    pub(super) fn update_tab_item_drag_hover(
        &self,
        app: &tauri::AppHandle,
        source_label: &str,
        tab_id: &str,
        drag_id: &str,
        point: tauri::PhysicalPosition<i32>,
    ) -> bool {
        let Ok(mut drag) = self.tab_item_drag.lock() else {
            return false;
        };
        let Some(session) = drag
            .as_mut()
            .filter(|session| session.matches(source_label, tab_id, drag_id))
        else {
            return false;
        };
        let next_target = self
            .registry
            .lock()
            .ok()
            .and_then(|registry| find_header_target(app, &registry, source_label, point));
        if next_target == session.hovered_target {
            return true;
        }
        let previous = std::mem::replace(&mut session.hovered_target, next_target.clone());
        let tab = self
            .registry
            .lock()
            .ok()
            .and_then(|registry| registry.tab_in_window(source_label, tab_id));
        drop(drag);
        if let Some(label) = previous {
            emit_merge_hover(app, &label, false, tab.clone());
        }
        if let Some(label) = next_target {
            emit_merge_hover(app, &label, true, tab.clone());
        }
        true
    }
}
