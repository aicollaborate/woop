use std::sync::{Arc, RwLock};

use crate::agent_external::runtime_registry::ExternalRuntimeRegistry;
use crate::agent_external_config::AgentExternalConfig;
use crate::agent_flowix::AgentManager;
use crate::agent_session::ThreadManager;
use crate::config::{AgentAccessStore, SecurityBookmarkStore, UserConfigStore};
use crate::system_data::SystemData;
use flowix_core::memo_file::MemoFile;
use flowix_core::search::MemoIndex;

/// 应用状�?—通过 `tauri::State<AppState>` 注入�?Tauri 命令和运行时服务�?///
/// `user_config` / `memo_file` / `thread_manager` �?`agent_manager` 之间会共�?/// 引用 (例�? `AgentManager` 需要�?�?thread_manager / memo_file), 共享形态是
/// `Arc<...>`, 不是 `Arc<RwLock<...>>` 套娃。锁的位�?��具体字�?内部�?///
/// `search` / `system_data` 没有跨模块需�? 保持原样 (�?Arc 包�?)�?
pub struct AppState {
    pub user_config: Arc<UserConfigStore>,
    pub cloud_sync: Arc<flowix_sync::SyncManager>,
    /// System metadata (notebook tag order/layout/hidden state).
    /// Stored at `~/.flowix/boot/system.json`.
    pub system_data: SystemData,
    /// External CLI 璺緞閰嶇疆 (`~/.flowix/agent-external-config.json`) 鈹€鈹€
    /// codex/claude/gemini/hermes/openclaw 鎵ц璺緞鐨勫敮涓€鍙傜収, 鍚姩鎺㈡祴鍐欏叆,
    /// 运�?�?`resolve_external_cli` 命中即用�?
    pub agent_external_config: AgentExternalConfig,
    pub memo_file: Arc<RwLock<MemoFile>>,
    /// 当前 notebook 的全文搜索索�?(内存倒排). 切换 notebook �?rebuild;
    /// 写命令�?�?upsert/remove.
    pub search: RwLock<MemoIndex>,
    pub agent_manager: Arc<AgentManager>,
    pub external_runtimes: Arc<ExternalRuntimeRegistry>,
    pub thread_manager: Arc<ThreadManager>,
    /// Agent �??�?���?(notebook + 用户�?���?folder), 持久化在
    /// `~/.flowix/agent-access.json`。驱�?[`crate::agent_flowix::tools::ToolScope`]
    /// �?`allowed_roots` �?`available_dirs` 工具的过滤�?
    pub agent_access: Arc<AgentAccessStore>,
    pub security_bookmarks: Arc<SecurityBookmarkStore>,
}
