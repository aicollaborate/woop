//! SQLite-backed agent-session facade.
//!
//! `ThreadManager` owns the single connection and the blocking-task boundary.
//! Domain-specific SQL lives in child modules while every method continues to
//! operate on this same connection, preserving cross-table transaction semantics.

mod conversations;
mod external;
mod messages;
mod threads;

use rusqlite::{params, Connection};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::error::ThreadError;

pub struct ThreadManager {
    conn: Mutex<Connection>,
}

fn external_default_title(runtime: &str) -> &'static str {
    match runtime {
        "claude" => "Claude Code session",
        "hermes" => "Hermes session",
        _ => "Codex session",
    }
}

impl ThreadManager {
    /// 娴�?�?��?fixture 鈹€鈹€ 涓嶅啓纾佺洏, �?`Connection::open_in_memory()` 寤轰竴涓┖搴撱�?    /// `agent.rs::for_tests` �?���? 鍥犱负鍗曞厓娴�?�?��獙�?`AgentManager` 鍐呴�?HashMap
    /// 鐘舵�? 涓嶇湡�?ｈ�?thread 搴撱�?
    #[cfg(test)]
    pub fn for_tests() -> Arc<ThreadManager> {
        Arc::new(Self::new_in_memory().expect("in-memory migrations failed"))
    }

    pub fn new(db_path: PathBuf) -> Result<Self, ThreadError> {
        let mut conn = Connection::open(db_path)?;
        Self::run_migrations(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn new_in_memory() -> Result<Self, ThreadError> {
        let mut conn = Connection::open_in_memory()?;
        Self::run_migrations(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 鍔犻攣鍔╂�? 鈹€鈹€ 閿佷腑姣?(panic held it) 鏃朵粛杩斿洖 guard, 涓嶈鍗曠�?panic
    /// 闃绘柇鍚庣画璇�?啓銆傛�?鏈�?啓鍏ラ兘鍏堣惤鐩樺啀鏇存柊鍐�?��, 杩欑绐楀彛鏈熸�?��戙€?    /// 閿欒绾у埆鐢?`tracing::error!`, �?`user_config.rs` 淇濇寔涓�?���?��?
    pub(crate) fn lock_conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| {
            tracing::error!("[ThreadManager] connection lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    /// 把同步 rusqlite 的工作丢到 tokio 阻塞线程池, 不卡 async worker。每个 async 公开
    /// 方法包一层 `_inner` 同步实现经此 helper 调度。`f` 与返回值须 Send + 'static
    /// (调用方负责把 `&str` 等 ref 参数先克隆成 owned 再 move 进闭包)。
    fn run_blocking<T, F>(
        self: &Arc<Self>,
        f: F,
    ) -> impl Future<Output = Result<T, ThreadError>> + Send
    where
        F: FnOnce(&ThreadManager) -> Result<T, ThreadError> + Send + 'static,
        T: Send + 'static,
    {
        let this = Arc::clone(self);
        async move {
            tokio::task::spawn_blocking(move || f(&this))
                .await
                .map_err(|e| ThreadError::Join(e.to_string()))?
        }
    }
    fn touch_thread(
        &self,
        conn: &Connection,
        thread_id: &str,
        updated_at: i64,
    ) -> Result<(), ThreadError> {
        conn.execute(
            "UPDATE threads SET updated_at = ?1 WHERE thread_id = ?2",
            params![updated_at, thread_id],
        )?;
        Ok(())
    }
}
