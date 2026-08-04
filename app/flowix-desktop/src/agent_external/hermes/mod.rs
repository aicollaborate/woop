mod history;

// History API ── �?~/.hermes/ 下的 session 导出 / list 命令输出�?
pub use history::{get_session, get_session_page, is_hermes_session_id};

// CLI runtime ── spawn `hermes` binary 子进�? stdout 不解析为 JSON, �?plain
// assistant text �?�� (�?8 MiB 兜底)。同 claude 一样�?�?shared 模块�?
pub mod cli;
pub use cli::HermesCliManager;
