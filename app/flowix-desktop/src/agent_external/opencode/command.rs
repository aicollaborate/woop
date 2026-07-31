use std::path::Path;
use tokio::process::Command;

use super::binary::resolve_opencode_binary;
use crate::agent_external::shared::configure_unix_process_group;

pub fn build_opencode_acp_command(cwd: &Path, permission_mode: Option<&str>) -> Command {
    let mut command = Command::new(resolve_opencode_binary());
    command.arg("acp").current_dir(cwd);
    configure_unix_process_group(&mut command);
    crate::process_window::hide_command_window(&mut command);

    if let Some(permission) = permission_config(permission_mode) {
        command.env("OPENCODE_PERMISSION", permission.to_string());
    }
    command
}

fn permission_config(mode: Option<&str>) -> Option<serde_json::Value> {
    match mode.map(str::trim) {
        Some("read-only") => Some(serde_json::json!({
            "*": "deny",
            "read": "allow",
            "glob": "allow",
            "grep": "allow",
            "list": "allow",
            "lsp": "allow",
            "skill": "allow",
            "webfetch": "allow",
            "websearch": "allow",
            "external_directory": "deny"
        })),
        Some("workspace-write") => Some(serde_json::json!({
            "*": "allow",
            "external_directory": "ask"
        })),
        Some("danger-full-access") | Some("yolo") => Some(serde_json::json!({
            "*": "allow"
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_blocks_mutation_and_shell() {
        let value = permission_config(Some("read-only")).unwrap();
        assert_eq!(value["*"], "deny");
        assert_eq!(value["read"], "allow");
        assert_eq!(value["grep"], "allow");
        assert_eq!(value["external_directory"], "deny");
    }

    #[test]
    fn workspace_write_asks_before_leaving_authorized_roots() {
        let value = permission_config(Some("workspace-write")).unwrap();
        assert_eq!(value["*"], "allow");
        assert_eq!(value["external_directory"], "ask");
    }

    #[test]
    fn inherit_preserves_opencode_configuration() {
        assert!(permission_config(Some("inherit")).is_none());
        assert!(permission_config(None).is_none());
    }

    #[test]
    fn full_access_uses_an_action_config_object() {
        let value = permission_config(Some("danger-full-access")).unwrap();
        assert!(value.is_object());
        assert_eq!(value["*"], "allow");
        assert_eq!(permission_config(Some("yolo")), Some(value));
    }
}
