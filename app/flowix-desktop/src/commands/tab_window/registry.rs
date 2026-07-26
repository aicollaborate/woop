//! Window registry state (no tauri::State, no locking at this layer).
use super::types::{WindowRegion, WindowTab};
use tauri::Manager;

#[derive(Debug, Clone)]
pub(super) struct WindowEntry {
    pub(super) label: String,
    pub(super) ready: bool,
    pub(super) tabs: Vec<WindowTab>,
    pub(super) tab_region: Option<WindowRegion>,
}

#[derive(Debug)]
pub(super) struct MoveRollback {
    source_label: String,
    source_window_index: usize,
    source_tab_index: usize,
    source_ready: bool,
    source_tab_region: Option<WindowRegion>,
    target_label: String,
    tab: WindowTab,
    target_inserted: bool,
}

#[derive(Debug, Default)]
pub(super) struct WindowRegistry {
    pub(super) windows: Vec<WindowEntry>,
}

impl WindowRegistry {
    pub(super) fn prune(&mut self, app: &tauri::AppHandle) {
        self.windows
            .retain(|entry| app.get_webview_window(&entry.label).is_some());
    }

    pub(super) fn find_tab(&self, tab_id: &str) -> Option<&WindowEntry> {
        self.windows
            .iter()
            .find(|entry| entry.tabs.iter().any(|tab| tab.id == tab_id))
    }

    pub(super) fn tab_in_window(&self, label: &str, tab_id: &str) -> Option<WindowTab> {
        self.windows
            .iter()
            .find(|entry| entry.label == label)
            .and_then(|entry| entry.tabs.iter().find(|tab| tab.id == tab_id))
            .cloned()
    }

    pub(super) fn add_window(&mut self, label: String, initial: WindowTab) {
        self.windows.push(WindowEntry {
            label,
            ready: false,
            tabs: vec![initial],
            tab_region: None,
        });
    }

    pub(super) fn append_to_last(&mut self, tab: WindowTab) -> Option<(String, bool)> {
        let entry = self.windows.last_mut()?;
        if !entry.tabs.iter().any(|candidate| candidate.id == tab.id) {
            entry.tabs.push(tab);
        }
        Some((entry.label.clone(), entry.ready))
    }

    pub(super) fn append_to(&mut self, label: &str, tab: WindowTab) -> Option<(String, bool)> {
        let entry = self.windows.iter_mut().find(|entry| entry.label == label)?;
        if !entry.tabs.iter().any(|candidate| candidate.id == tab.id) {
            entry.tabs.push(tab);
        }
        Some((entry.label.clone(), entry.ready))
    }

    pub(super) fn mark_ready(&mut self, label: &str) -> Option<Vec<WindowTab>> {
        let entry = self.windows.iter_mut().find(|entry| entry.label == label)?;
        entry.ready = true;
        Some(entry.tabs.clone())
    }

    pub(super) fn set_tab_region(
        &mut self,
        label: &str,
        region: WindowRegion,
    ) -> Result<(), String> {
        let entry = self
            .windows
            .iter_mut()
            .find(|entry| entry.label == label)
            .ok_or_else(|| "tab window is unavailable".to_string())?;
        entry.tab_region = Some(region);
        Ok(())
    }

    pub(super) fn close_tab(&mut self, label: &str, tab_id: &str) {
        if let Some(entry) = self.windows.iter_mut().find(|entry| entry.label == label) {
            entry.tabs.retain(|tab| tab.id != tab_id);
        }
        self.windows.retain(|entry| !entry.tabs.is_empty());
    }

    pub(super) fn close_window(&mut self, label: &str) {
        self.windows.retain(|entry| entry.label != label);
    }

    pub(super) fn reorder_tab(
        &mut self,
        label: &str,
        tab_id: &str,
        before_tab_id: Option<&str>,
    ) -> Result<(), String> {
        let entry = self
            .windows
            .iter_mut()
            .find(|entry| entry.label == label)
            .ok_or_else(|| "tab window is unavailable".to_string())?;
        let source_index = entry
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("tab is not registered in source window: {tab_id}"))?;
        if before_tab_id == Some(tab_id) {
            return Ok(());
        }
        if let Some(before_id) = before_tab_id {
            if !entry.tabs.iter().any(|tab| tab.id == before_id) {
                return Err(format!(
                    "target tab is not registered in source window: {before_id}"
                ));
            }
        }
        let tab = entry.tabs.remove(source_index);
        let target_index = before_tab_id
            .and_then(|before_id| {
                entry
                    .tabs
                    .iter()
                    .position(|candidate| candidate.id == before_id)
            })
            .unwrap_or(entry.tabs.len());
        entry.tabs.insert(target_index, tab);
        Ok(())
    }

    pub(super) fn mark_focused(&mut self, label: &str) {
        let Some(index) = self.windows.iter().position(|entry| entry.label == label) else {
            return;
        };
        let entry = self.windows.remove(index);
        self.windows.push(entry);
    }

    pub(super) fn move_tab(
        &mut self,
        source_label: &str,
        tab_id: &str,
        target_label: &str,
        refreshed_tab: WindowTab,
    ) -> Result<(WindowTab, bool, MoveRollback), String> {
        let source_window_index = self
            .windows
            .iter()
            .position(|entry| entry.label == source_label)
            .ok_or_else(|| "source tab window is unavailable".to_string())?;
        let source = &self.windows[source_window_index];
        let source_tab_index = source
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("tab is not registered in source window: {tab_id}"))?;
        let source_ready = source.ready;
        let source_tab_region = source.tab_region;
        let target = self
            .windows
            .iter_mut()
            .find(|entry| entry.label == target_label)
            .ok_or_else(|| "target tab window is unavailable".to_string())?;
        let target_inserted = !target
            .tabs
            .iter()
            .any(|candidate| candidate.id == refreshed_tab.id);
        if target_inserted {
            target.tabs.push(refreshed_tab.clone());
        }
        let ready = target.ready;
        self.close_tab(source_label, tab_id);
        let rollback = MoveRollback {
            source_label: source_label.to_string(),
            source_window_index,
            source_tab_index,
            source_ready,
            source_tab_region,
            target_label: target_label.to_string(),
            tab: refreshed_tab.clone(),
            target_inserted,
        };
        Ok((refreshed_tab, ready, rollback))
    }

    pub(super) fn rollback_move(&mut self, rollback: MoveRollback) {
        if rollback.target_inserted {
            if let Some(target) = self
                .windows
                .iter_mut()
                .find(|entry| entry.label == rollback.target_label)
            {
                target.tabs.retain(|tab| tab.id != rollback.tab.id);
            }
        }
        if let Some(source) = self
            .windows
            .iter_mut()
            .find(|entry| entry.label == rollback.source_label)
        {
            if !source.tabs.iter().any(|tab| tab.id == rollback.tab.id) {
                let index = rollback.source_tab_index.min(source.tabs.len());
                source.tabs.insert(index, rollback.tab);
            }
            return;
        }
        let index = rollback.source_window_index.min(self.windows.len());
        self.windows.insert(
            index,
            WindowEntry {
                label: rollback.source_label,
                ready: rollback.source_ready,
                tabs: vec![rollback.tab],
                tab_region: rollback.source_tab_region,
            },
        );
    }
}

#[derive(Debug)]
pub(super) struct TabItemDrag {
    pub(super) source_label: String,
    pub(super) tab_id: String,
    pub(super) drag_id: String,
    pub(super) hovered_target: Option<String>,
}

impl TabItemDrag {
    pub(super) fn matches(&self, source_label: &str, tab_id: &str, drag_id: &str) -> bool {
        self.source_label == source_label && self.tab_id == tab_id && self.drag_id == drag_id
    }
}
