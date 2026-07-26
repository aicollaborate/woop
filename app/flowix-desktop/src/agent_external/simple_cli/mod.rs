// �?claude/codex/hermes 不同, simple_cli 没有�?���?history 子模�?──
// Gemini / OpenClaw �?session 仍由各自�?`~/.gemini/` / `~/.openclaw/`
// �?��持有, 但前�?UI 不直接列历史 (�?���?session �?chat_stream), 所�?// 这里保持单文件即�?�?//
// 整个 simple_cli 子模块的存在意义: �?Gemini + OpenClaw 两�? "�?stdout
// 文本输出" �?small CLI 整合到一�?manager 后面, 共享 ExternalRunRegistry
// 注册�?+ kill_child_tree �?shared 工具, 不再让单�?vendor �?��造一份�?
mod cli;
pub use cli::*;
