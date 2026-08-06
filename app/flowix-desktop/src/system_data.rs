use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

/// System metadata stored at `~/.flowix/boot/system.json`.
///
/// This file is for app-owned runtime state that is not user preference and not
/// notebook content. Current data is tag navigation state, grouped by notebook.
pub struct SystemData {
    path: PathBuf,
    data: RwLock<SystemFile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFile {
    #[serde(default)]
    pub tag: TagSystemData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSystemData {
    #[serde(default)]
    pub notebooks: HashMap<String, NotebookTagSystemData>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookTagSystemData {
    #[serde(default)]
    pub hidden: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub layout: Vec<TagLayoutItem>,
    /// 置顶标签簿: parent fullPath → MRU 顺序的子 fullPath 列表。
    /// 空 key (`""`) 表示 root 级别。Vec 索引 0 = 最近置顶 = 渲染最前。
    /// 单一调用方 (`set_pinned_tags`) 负责整组写回, 以便 rename / delete /
    /// reparent 迁移时一次落盘。
    #[serde(default)]
    pub pinned_by_parent: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagLayoutItem {
    pub id: String,
    pub parent_id: Option<String>,
}

impl SystemData {
    pub fn new(path: PathBuf) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = Self::read_from_disk(&path).unwrap_or_default();
        Ok(Self {
            path,
            data: RwLock::new(data),
        })
    }

    pub fn transient(path: PathBuf) -> Self {
        tracing::warn!(
            "system data is running in transient mode; writes to {} may fail",
            path.display()
        );
        Self {
            path,
            data: RwLock::new(SystemFile::default()),
        }
    }

    fn read_data(&self) -> RwLockReadGuard<'_, SystemFile> {
        self.data.read().unwrap_or_else(|poisoned| {
            tracing::error!("system data lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn write_data(&self) -> RwLockWriteGuard<'_, SystemFile> {
        self.data.write().unwrap_or_else(|poisoned| {
            tracing::error!("system data lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn read_from_disk(path: &PathBuf) -> Option<SystemFile> {
        if !path.exists() {
            return None;
        }
        let content = fs::read_to_string(path).ok()?;
        match serde_json::from_str::<SystemFile>(&content) {
            Ok(data) => Some(data),
            Err(e) => {
                tracing::warn!("system.json parse error: {e}, falling back to empty");
                None
            }
        }
    }

    fn flush(&self, data: &SystemFile) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(data)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp)?;
            f.write_all(content.as_bytes())?;
            f.sync_all()?;
        }
        set_file_owner_only_perms(&tmp);
        fs::rename(&tmp, &self.path)?;
        set_file_owner_only_perms(&self.path);
        Ok(())
    }

    pub fn get_tag_metadata(&self, notebook_id: &str) -> NotebookTagSystemData {
        let data = self.read_data();
        data.tag
            .notebooks
            .get(notebook_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn set_tag_layout(
        &self,
        notebook_id: &str,
        layout: Vec<TagLayoutItem>,
    ) -> std::io::Result<()> {
        let mut data = self.write_data();
        let notebook = data
            .tag
            .notebooks
            .entry(notebook_id.to_string())
            .or_default();
        notebook.order = layout.iter().map(|item| item.id.clone()).collect();
        notebook.layout = layout;
        self.flush(&data)
    }

    pub fn set_hidden_tags(&self, notebook_id: &str, hidden: Vec<String>) -> std::io::Result<()> {
        let mut data = self.write_data();
        let notebook = data
            .tag
            .notebooks
            .entry(notebook_id.to_string())
            .or_default();
        notebook.hidden = hidden;
        self.flush(&data)
    }

    /// 写回某 parent 下的 pinned 列表（MRU 顺序）。
    /// - `parent_id` 为 `None` 时使用 root 哨兵 `""`。
    /// - `pinned` 为空 Vec 时直接 `remove` 该 key，保持 `pinned_by_parent` 干净。
    pub fn set_pinned_tags(
        &self,
        notebook_id: &str,
        parent_id: Option<&str>,
        pinned: Vec<String>,
    ) -> std::io::Result<()> {
        let mut data = self.write_data();
        let notebook = data
            .tag
            .notebooks
            .entry(notebook_id.to_string())
            .or_default();
        let key = parent_id.unwrap_or("").to_string();
        if pinned.is_empty() {
            notebook.pinned_by_parent.remove(&key);
        } else {
            notebook.pinned_by_parent.insert(key, pinned);
        }
        self.flush(&data)
    }
}

#[cfg(unix)]
fn set_file_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    let _ = std::fs::set_permissions(path, perms);
}

#[cfg(not(unix))]
fn set_file_owner_only_perms(_path: &Path) {}
