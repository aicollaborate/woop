use std::path::Path;
use std::sync::{Arc, RwLock};

use tauri::{AppHandle, Manager};

use crate::watcher::manager::MemoWatcher;
use flowix_core::memo_file::atomic_write_bytes;

pub fn current_watcher(app: &AppHandle) -> Option<Arc<RwLock<MemoWatcher>>> {
    app.try_state::<Arc<RwLock<MemoWatcher>>>()
        .map(|s| s.inner().clone())
}

pub(crate) fn mark_self_write_for(app: &AppHandle, path: &Path) {
    if let Some(w) = current_watcher(app) {
        if let Ok(g) = w.read() {
            g.mark_self_write(path);
        }
    }
}

/// 原子写一篇笔记，并自动登记自身写入标记（写前 + 写后各一次）。
///
/// 文件监听器仅凭内容哈希精确匹配判定自身写入（路径匹配不够）：写前标记关闭 notify
/// 抢跑窗口，写后标记捕获刚落盘的新内容哈希，两次缺一不可。把双标记收进此函数，让
/// 所有笔记写盘点（云同步 apply / frontmatter 规范化 / 编辑器保存等）统一复用，从根
/// 上避免某个写盘点漏掉写后标记、导致监听器把自身写盘误判为外部编辑。
pub(crate) fn write_note_atomic(
    app: &AppHandle,
    path: &Path,
    content: &[u8],
) -> std::io::Result<()> {
    mark_self_write_for(app, path);
    atomic_write_bytes(path, content)?;
    mark_self_write_for(app, path);
    Ok(())
}
