use std::path::PathBuf;

use tokio::process::Command;

use super::binary::resolve_codex_binary;
use super::AGENT_TYPE;
use crate::agent_external::node::node_runtime_target;

/// Resolve the working directory for an app-server thread from Flowix's
/// runtime configuration. App-server owns Codex thread state, so Flowix does
/// not inspect Codex rollout files as a fallback.
pub(crate) fn resolve_codex_cwd(
    message: &crate::agent_wire::AgentUserMessage,
    _session_id: Option<&str>,
) -> Option<PathBuf> {
    message
        .cwd_for_runtime(AGENT_TYPE)
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

/// Build the executable used by app-server and model-discovery commands.
pub(crate) fn build_codex_entrypoint() -> Command {
    let codex = resolve_codex_binary();
    let resolved = std::fs::canonicalize(&codex).unwrap_or_else(|_| codex.clone());
    let mut command = match resolved
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("js") => {
            let node = resolve_node_binary().unwrap_or_else(|| PathBuf::from("node"));
            let mut command = Command::new(node);
            command.arg(resolved);
            command
        }
        _ => {
            let mut command = Command::new(codex);
            crate::agent_external::node::ensure_node_on_path(&mut command);
            command
        }
    };
    // Codex is a background stdio service. In particular, npm's `codex.cmd`
    // shim otherwise creates a visible console window on Windows.
    crate::process_window::hide_command_window(&mut command);
    command
}

/// Verify that a JavaScript-distributed Codex CLI has a compatible Node
/// runtime and optional native package before starting app-server.
pub(crate) fn preflight_codex() -> Result<(), String> {
    let codex = resolve_codex_binary();
    let resolved = std::fs::canonicalize(&codex).unwrap_or(codex);
    if resolved
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("js")
    {
        return Ok(());
    }
    let node = resolve_node_binary().ok_or_else(|| {
        format!(
            "Codex requires Node.js, but none was found. Install Node.js or set CODEX_NODE_PATH. (Codex binary: {})",
            resolve_codex_binary().display()
        )
    })?;
    let Some((platform, arch)) = node_runtime_target(&node) else {
        return Ok(());
    };
    let Some(package) = codex_native_package(&platform, &arch) else {
        return Err(format!(
            "Codex does not support the current Node.js runtime ({platform}/{arch}). (Node binary: {})",
            node.display()
        ));
    };
    let Some(root) = codex_package_root(&resolved) else {
        return Ok(());
    };
    if !root.join("package.json").is_file() || find_node_package(&root, package).is_some() {
        return Ok(());
    }
    Err(format!(
        "Codex native dependency `{package}` is missing. Reinstall with `npm install -g @openai/codex@latest --force --include=optional`, or set CODEX_NODE_PATH to a matching Node.js runtime."
    ))
}

fn resolve_node_binary() -> Option<PathBuf> {
    crate::agent_external::node::resolve_node_binary("CODEX_NODE_PATH")
}

fn codex_native_package(platform: &str, arch: &str) -> Option<&'static str> {
    match (platform, arch) {
        ("darwin", "x64") => Some("@openai/codex-darwin-x64"),
        ("darwin", "arm64") => Some("@openai/codex-darwin-arm64"),
        ("linux", "x64") => Some("@openai/codex-linux-x64"),
        ("linux", "arm64") => Some("@openai/codex-linux-arm64"),
        ("win32", "x64") => Some("@openai/codex-win32-x64"),
        ("win32", "arm64") => Some("@openai/codex-win32-arm64"),
        _ => None,
    }
}

fn codex_package_root(codex: &std::path::Path) -> Option<PathBuf> {
    let bin_dir = codex.parent()?;
    (bin_dir.file_name().and_then(|name| name.to_str()) == Some("bin"))
        .then(|| bin_dir.parent().map(PathBuf::from))?
}

fn find_node_package(package_root: &std::path::Path, package_name: &str) -> Option<PathBuf> {
    let mut current = Some(package_root);
    while let Some(root) = current {
        let candidate = package_name
            .split('/')
            .fold(root.join("node_modules"), |path, part| path.join(part));
        if candidate.is_dir() {
            return Some(candidate);
        }
        current = root.parent();
    }
    None
}
