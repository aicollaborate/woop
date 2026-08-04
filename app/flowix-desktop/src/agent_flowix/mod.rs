mod context;
mod factory;
mod persistence;
mod prompt;
pub(crate) mod providers;
pub(crate) mod skills;
// `pub(crate)` because `commands::settings::test_ai_connection` calls
// `agent::provider::probe_chat` directly 鈥?but we keep the module's
// internal items (`pub(super)`) only visible to the `agent` module so
// we don't expose chat-stream plumbing outside of agent.rs.
pub(crate) mod provider;
mod state;
mod stream;
mod tool_runtime;
pub(crate) mod tools;
mod wire;

pub use crate::agent_types::{default_agent_id, AgentId, StatusInfo, UsageInfo};
#[allow(unused_imports)]
pub use wire::{
    AgentChatResponse, AgentChunk, AgentError, AgentRuntimeConfig, AgentUserMessage, RunInfo,
    RuntimePathConfig,
};

use std::collections::HashMap;
use std::sync::Arc;

use crate::agent_flowix::skills::SkillStore;
use crate::agent_session::ThreadManager;
use crate::config::AgentAccessStore;
use crate::config::SecurityBookmarkStore;
use crate::config::UserConfigStore;
use factory::CachedInstance;
use flowix_core::memo_file::MemoFile;
use state::{CallKey, InFlightChat};

/// AgentManager 现在�?���?当前生效�?provider 实例", 真�?的配�?��源是
/// `~/.flowix/agent-config.toml` (�?`UserConfigStore` 暴露)。每�?chat
/// 调用前�?最新配�? 与构建缓存的配置对比, 不一致则重建 provider�?///
/// 杩欐牱 ai_config 鍙樻洿 (渚嬪鐢ㄦ埛鍦ㄥ亸濂介噷鎹簡妯″瀷 / API key) 涓嶅啀渚濊禆鍓嶇閲嶆柊
/// "init agent", 后�?�?��感知并热替换�?///
/// 三个 `Arc<...>` 依赖�?`lib.rs` 注入, �?`AppState` 共享同一份引�?(refcount=2):
/// - `user_config`: 璇?agent-config.toml
/// - `thread_manager`: 钀界洏 chat 鍘嗗彶
/// - `memo_file`: 工具读写的真实笔�?///
/// 杩欎笁涓瓧娈典箣鍓嶆槸 `chat_stream` 绛夋柟娉曠殑 `app_state: &crate::app::state::AppState`
/// 鍙傛暟 鈹€鈹€ 妯″潡鍙嶅悜渚濊禆 commands銆傛敞鍏ュ悗 agent 涓嶅啀渚濊禆 commands 妯″潡, 鍙互
/// 单独测试 (�?`for_tests` 构造器)�?
pub struct AgentManager {
    instance: tokio::sync::RwLock<Option<CachedInstance>>,
    /// 每个 thread �?read 工具�?��。edit 工具需�?read 后的内�?做漂移�?测�?
    read_snapshots: tokio::sync::RwLock<HashMap<String, HashMap<String, String>>>,
    /// 每个 thread �?(tool_name, args_hash) �?�??调用次数�?
    /// 超过 STUCK_THRESHOLD 视为 LLM 卡在�?���? 熔断。LLM 给最终回�?
    /// (�?tool call) �?chat 异常退出时�?chat_stream 入口清空�?
    tool_call_attempts: tokio::sync::RwLock<HashMap<String, HashMap<CallKey, u32>>>,
    /// 每个 thread 当前正在跑的 chat_stream 状态。取消标志、开始时间�?    /// run_id 以前分散�?`cancel_flags` / `started_at` 两把锁里, 生命周期
    /// 需要两处同步维护；现在收敛成单�?registry, register / stop /
    /// unregister 都只改一�?entry�?
    in_flight: tokio::sync::Mutex<HashMap<String, InFlightChat>>,
    /// ai_config 鐪熸簮 (`~/.flowix/agent-config.toml`)
    user_config: Arc<UserConfigStore>,
    /// 线程�?(chat 历史的持久化)
    thread_manager: Arc<ThreadManager>,
    /// 笔�?�?���?(工具读写的�?�?
    memo_file: Arc<std::sync::RwLock<MemoFile>>,
    /// Agent �??�?��录真�?(`~/.flowix/agent-access.json`)�?
    /// `execute_tool` 鎶婂畠鍠傜粰 `ToolScope::from_memo_file_and_access`
    /// 决定 `allowed_roots`, 也用来过�?`available_dirs` 工具的返回�?    // `agent-access.json` backs defaults and legacy/global fallback. For a
    // real agent-thread-card run, Flowix tool scope should use the message
    // runtime config workspace paths when present.
    agent_access: Arc<AgentAccessStore>,
    /// macOS security-scoped bookmarks for user-selected notebook / agent roots.
    security_bookmarks: Arc<SecurityBookmarkStore>,
    /// Skills registry (`~/.flowix/skills/.system/` + 用户�?���?�?
    /// 系统 prompt builder �?`summaries()` 注入 "# Skills" �?
    /// `load_skill` 工具 handler �?`get(name)` �?body�?
    /// �?��后不�?�� ── 无内部锁, `Arc` 共享�?prompt builder / tool handler�?
    skill_store: Arc<SkillStore>,
    /// AppHandle 由 bootstrap 在 Tauri `.setup` 阶段注入（构造时尚未进入 run()）。
    /// agent 的 memo 写入工具（如 delete）据此 mark_self_write + emit memo-event，
    /// 不再依赖 watcher 对 Remove 的被动反查（见 operations.rs `delete`）。
    app_handle: std::sync::OnceLock<tauri::AppHandle>,
}

/// �?`AgentManager` drop 时清掉与每个 thread 关联�?in-memory 状�?──
/// 瑙ｅ喅 #3.5: Tauri 杩涚▼閫€鍑烘椂 `instance: tokio::sync::RwLock<Option<CachedInstance>>`
/// 里的 `CachedInstance` (�?rllm client / reqwest HTTP client) �?/// graceful shutdown, �?��造成:
/// - 在�?请求�?���?(用户看到一半的响应)
/// - 杩炴帴姹犳湭 flush (鎿嶄綔绯荤粺灞傞潰 close, 浣嗘垜浠病娉曠瓑)
///
/// 不在 drop �?spawn 额�? task �?cancel 活跃 stream ── 留给 reqwest �?��毁�?/// `instance` / `read_snapshots` / `tool_call_attempts` / `in_flight` 都是
/// `Arc<...>`, 单个 owner drop �?refcount 减一, 不阻塞真正的 I/O 关停�?/// �?��责把"我们维护�?状态显式打 log, 便于排障时区�?�?drop �? vs
/// "进程�?SIGKILL"�?
impl Drop for AgentManager {
    fn drop(&mut self) {
        tracing::info!("[AgentManager] dropping; flushing in-memory state");
        // 锁取不到不阻�?── 锁中毒或活跃写锁都不会�? Drop 失败, 这条
        // �?���?��程退出最后的清理, 不�? panic�?
        if let Ok(snapshots) = self.read_snapshots.try_read() {
            if !snapshots.is_empty() {
                tracing::info!(
                    "[AgentManager] dropping with {} read_snapshots entries",
                    snapshots.len()
                );
            }
        }
        if let Ok(attempts) = self.tool_call_attempts.try_read() {
            if !attempts.is_empty() {
                tracing::info!(
                    "[AgentManager] dropping with {} tool_call_attempts entries",
                    attempts.len()
                );
            }
        }
        if let Ok(in_flight) = self.in_flight.try_lock() {
            if !in_flight.is_empty() {
                tracing::info!(
                    "[AgentManager] dropping with {} active in-flight chats",
                    in_flight.len()
                );
            }
        }
    }
}

impl AgentManager {
    /// 构造时必须传入共享依赖 ── �?`AppState` 持有同一�?Arc 引用�?    /// 这样 `agent` 模块不再依赖 `AppState` (历史 P2-#2 反向依赖)�?
    pub fn new(
        user_config: Arc<UserConfigStore>,
        thread_manager: Arc<ThreadManager>,
        memo_file: Arc<std::sync::RwLock<MemoFile>>,
        agent_access: Arc<AgentAccessStore>,
        security_bookmarks: Arc<SecurityBookmarkStore>,
        skill_store: Arc<SkillStore>,
    ) -> Self {
        Self {
            instance: tokio::sync::RwLock::new(None),
            read_snapshots: tokio::sync::RwLock::new(HashMap::new()),
            tool_call_attempts: tokio::sync::RwLock::new(HashMap::new()),
            in_flight: tokio::sync::Mutex::new(HashMap::new()),
            user_config,
            thread_manager,
            memo_file,
            agent_access,
            security_bookmarks,
            skill_store,
            app_handle: std::sync::OnceLock::new(),
        }
    }

    /// 由 bootstrap 在 Tauri `.setup` 阶段注入 AppHandle（`AgentManager::new` 时
    /// 尚未 run()，拿不到 handle）。注入后 agent 工具链据此 emit memo-event。
    pub fn set_app_handle(&self, app: tauri::AppHandle) {
        let _ = self.app_handle.set(app);
    }

    /// 测试�?fixture ── 用空 / 临时�?��构造依�? 不真正�?写业务�?盘�?    /// 现存的单元测试只验证 `record_tool_call` / `clear_tool_call_attempts` /
    /// `cleanup_thread` �?HashMap 状�? 不触�?`user_config` / `thread_manager` /
    /// `memo_file` / `agent_access` (鍙傝 `cleanup_thread_removes_read_snapshot`
    /// 注释: "can't call `execute_tool_for_thread` because it lacks `memo_file`")�?    /// skill_store 用空�?��构�?(没有 SKILL.md 时返回空 store, 不影响既有断言)�?
    #[cfg(test)]
    pub fn for_tests() -> Self {
        let home = std::env::temp_dir().join(format!("agent_mgr_test_{}", std::process::id()));
        std::fs::create_dir_all(&home).ok();
        let skills_root = home.join("skills");
        std::fs::create_dir_all(&skills_root).ok();
        Self::new(
            Arc::new(UserConfigStore::new(home.clone())),
            crate::agent_session::ThreadManager::for_tests(),
            Arc::new(std::sync::RwLock::new(MemoFile::default())),
            Arc::new(AgentAccessStore::new(
                home.join(".flowix"),
                &MemoFile::default(),
            )),
            Arc::new(SecurityBookmarkStore::new(home.join(".flowix"))),
            Arc::new(SkillStore::load(&skills_root)),
        )
    }
}

#[cfg(test)]
mod tests;
