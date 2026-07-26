//! Tab-window coordinator (registry + facade + IPC). Re-exports the 13
//! #[tauri::command] functions plus `TabWindowCoordinator` and
//! `route_markdown_path_tab` so `bootstrap.rs` keeps the flat
//! `commands::tab_window::<name>` paths.
pub mod geometry;
pub mod ipc_events;
pub mod registry;
pub mod resolution;
pub mod types;
pub mod window;

pub mod commands;
pub(super) mod coordinator;

pub use commands::*;
pub use coordinator::TabWindowCoordinator;
pub use window::route_markdown_path_tab;

#[cfg(test)]
mod tests;
