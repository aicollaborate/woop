use std::path::PathBuf;

use crate::agent_external::cli_resolver::{
    no_extra_candidates, resolve_external_cli, ExternalCliSpec,
};

const OPENCODE_CLI_SPEC: ExternalCliSpec = ExternalCliSpec {
    binary_name: "opencode",
    #[cfg(windows)]
    windows_binary_name: "opencode.cmd",
    env_vars: &["OPENCODE_CLI_PATH"],
    extra_unix_candidates: no_extra_candidates,
    #[cfg(windows)]
    extra_windows_candidates: no_extra_candidates,
};

pub fn resolve_opencode_binary() -> PathBuf {
    resolve_external_cli(&OPENCODE_CLI_SPEC)
}
