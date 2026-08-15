// `deepseek_harness_e2e` 集成测试需要真实 Wry AppHandle（主线程）+ 仓内类型,
// 因此这几个模块对外可见。app crate 无外部消费者, 可见性放宽无成本。
pub mod agent_external;
mod agent_external_config;
pub mod agent_flowix;
pub mod agent_session;
mod agent_types;
mod app;
mod apple_sign_in;
mod cli_link;
mod commands;
pub mod config;
mod device_registration;
mod document_mutation;
mod events;
mod lock_utils;
mod memo_events;
mod open_target;
mod plugin;
mod process_window;
mod runtime_log;
mod system_data;
mod watcher;
mod window_chrome;

pub use app::{get_app_data_path, get_user_config_dir, APP_DATA_DIR_NAME, USER_CONFIG_DIR_NAME};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run();
}
