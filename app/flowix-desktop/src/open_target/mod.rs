//! 全局"通过链接打开笔�?"模块 —覆盖 3 �?���?
//!
//! 1. 外部深链 `flowix://memo/<id>` (浏�?�?/ 终�? / 其它 app 触发, 冷启�?+ 二�?�?��)
//! 2. 产品内物理路�?(e.g. `/Users/.../xxx#vex4v.md`)
//! 3. 产品内深�?(Agent 输出 / 跨窗�?/ 复制粘贴)
//!
//! ## 鍒嗗眰
//!
//! - [`parser`]    —�?��符串解析 (URL / 物理�?�� �?[`OpenTarget`])�?无副作用�?//! - [`resolver`]  —[`OpenTarget`] �?[`ResolvedOpenTarget`] (查�?�? �?notebook)�?//! - [`handler`]   —`#[tauri::command] open_memo_by_target` + emit `flowix:open-target`�?//!
//! ## URL scheme
//!
//! - `flowix://memo/<memo-id>`              —主�?场景
//! - `flowix://open?path=<encoded-abs>`     —物理�?�� (内部�?id �?
//!
//! 后�? IPC 命令接收**任意**标识符形�?(URL / 物理�?��), 内部�?[`parse_open_target`]
//! 规整�?[`OpenTarget`], �?[`resolve_open_target`] 拿到 [`ResolvedOpenTarget`],
//! �?`flowix:open-target` 事件给前�?�?前�?�?切换 notebook + 打开 document"�?
pub mod handler;
pub mod parser;
pub mod resolver;

// Re-exports 留给测试 / 文档�? 真�?注册�?Tauri IPC �?`open_memo_by_target`
// �?`lib.rs` 走完整路�?`open_target::handler::open_memo_by_target`, 这样
// `#[tauri::command]` 宏生成的 `__cmd__` 兄弟符号才能�?`generate_handler!` 找到�?
#[allow(unused_imports)]
pub use parser::{parse_open_target, OpenTarget, OpenTargetError};
#[allow(unused_imports)]
pub use resolver::{resolve_open_target, ResolveError, ResolvedOpenTarget};
