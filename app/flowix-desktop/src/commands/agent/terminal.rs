use std::{path::Path, process::Command};

#[cfg(target_os = "windows")]
const CODEX_INSTALL_COMMAND: &str =
    "npm.cmd install -g @openai/codex@latest --force --include=optional";

#[cfg(not(target_os = "windows"))]
const CODEX_INSTALL_COMMAND: &str =
    "npm install -g @openai/codex@latest --force --include=optional";

#[tauri::command]
pub fn open_codex_cli_install_terminal() -> Result<(), String> {
    open_terminal_with_command(CODEX_INSTALL_COMMAND)
}

#[tauri::command]
pub fn open_codex_config() -> Result<(), String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve the home directory".to_string())?;
    let config_dir = home.join(".codex");
    let config_path = config_dir.join("config.toml");
    std::fs::create_dir_all(&config_dir).map_err(|err| err.to_string())?;
    if !config_path.exists() {
        std::fs::write(
            &config_path,
            "# Codex CLI configuration\n# Add custom model settings here.\n",
        )
        .map_err(|err| err.to_string())?;
    }
    open_config_file(&config_path)
}

#[cfg(target_os = "windows")]
fn open_terminal_with_command(command: &str) -> Result<(), String> {
    Command::new("powershell.exe")
        .args([
            "-NoExit",
            "-Command",
            &format!("{command}; Write-Host ''; Write-Host 'Codex CLI install command finished.'"),
        ])
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}
#[cfg(target_os = "windows")]
fn open_config_file(path: &Path) -> Result<(), String> {
    Command::new("notepad.exe")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "macos")]
fn open_terminal_with_command(command: &str) -> Result<(), String> {
    Command::new("osascript")
        .args([
            "-e",
            &format!(
                "tell application \"Terminal\" to do script \"{}\"",
                escape_applescript(command)
            ),
            "-e",
            "tell application \"Terminal\" to activate",
        ])
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "macos")]
fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn open_config_file(path: &Path) -> Result<(), String> {
    Command::new("open")
        .args(["-t"])
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal_with_command(command: &str) -> Result<(), String> {
    let shell_command = format!("{command}; echo; read -r -p 'Press Enter to close...'");
    let candidates: &[(&str, &[&str])] = &[
        ("x-terminal-emulator", &["-e", "sh", "-lc"]),
        ("gnome-terminal", &["--", "sh", "-lc"]),
        ("konsole", &["-e", "sh", "-lc"]),
        ("xfce4-terminal", &["-e", "sh -lc"]),
        ("xterm", &["-e", "sh", "-lc"]),
    ];

    for (program, args) in candidates {
        let mut cmd = Command::new(program);
        cmd.args(*args);
        cmd.arg(&shell_command);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    Err("Could not find a supported terminal application".to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_config_file(path: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}
