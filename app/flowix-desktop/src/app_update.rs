use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use std::time::Duration;
use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

const UPDATE_ENDPOINT: &str = "https://download.flowix.cc/updater/";

#[derive(Default)]
pub struct AppUpdateState { active: Mutex<Option<std::sync::Arc<AtomicBool>>> }

#[derive(Debug, Deserialize)]
struct Manifest { version: String, platforms: std::collections::HashMap<String, PlatformRelease> }

#[derive(Debug, Deserialize)]
struct PlatformRelease { url: String, #[serde(default)] sha256: Option<String> }

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo { pub current_version: String, pub version: String, pub date: Option<String>, pub body: Option<String> }

#[tauri::command]
pub async fn check_app_update() -> Result<Option<AppUpdateInfo>, String> {
    let platform = updater_platform();
    let target = updater_target();
    let client = Client::builder().timeout(Duration::from_secs(15)).build()
        .map_err(|e| format!("create update client: {e}"))?;
    let manifest: Manifest = client.get(format!("{UPDATE_ENDPOINT}{platform}/latest.json"))
        .send().await.map_err(|e| format!("download update manifest: {e}"))?
        .error_for_status().map_err(|e| format!("download update manifest: {e}"))?
        .json().await.map_err(|e| format!("parse update manifest: {e}"))?;
    if manifest.platforms.get(target).is_none() { return Err(format!("update manifest has no target {target}")); }
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    let available = semver::Version::parse(manifest.version.trim()).map_err(|e| format!("invalid update version: {e}"))?;
    if available <= current { return Ok(None); }
    Ok(Some(AppUpdateInfo { current_version: current.to_string(), version: available.to_string(), date: None, body: None }))
}

#[tauri::command]
pub async fn install_app_update(app: AppHandle, state: State<'_, AppUpdateState>) -> Result<(), String> {
    let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    {
        let mut active = state.active.lock().map_err(|_| "application update state is unavailable")?;
        if active.is_some() { return Err("an application update is already downloading".into()); }
        *active = Some(cancelled.clone());
    }
    let result = download_and_launch(&app, &cancelled).await;
    if let Ok(mut active) = state.active.lock() { *active = None; }
    result
}

#[tauri::command]
pub fn cancel_app_update(state: State<'_, AppUpdateState>) -> Result<bool, String> {
    let active = state.active.lock().map_err(|_| "application update state is unavailable")?;
    if let Some(flag) = active.as_ref() { flag.store(true, Ordering::Release); return Ok(true); }
    Ok(false)
}

async fn download_and_launch(app: &AppHandle, cancelled: &AtomicBool) -> Result<(), String> {
    let platform = updater_platform();
    let target = updater_target();
    let client = Client::builder().timeout(Duration::from_secs(15 * 60)).build()
        .map_err(|e| format!("create update client: {e}"))?;
    let manifest: Manifest = client.get(format!("{UPDATE_ENDPOINT}{platform}/latest.json"))
        .send().await.map_err(|e| format!("download update manifest: {e}"))?
        .error_for_status().map_err(|e| format!("download update manifest: {e}"))?
        .json().await.map_err(|e| format!("parse update manifest: {e}"))?;
    let release = manifest.platforms.get(target).ok_or_else(|| format!("update manifest has no target {target}"))?;
    let response = client.get(&release.url).send().await
        .map_err(|e| format!("download application update: {e}"))?
        .error_for_status().map_err(|e| format!("download application update: {e}"))?;
    let total = response.content_length();
    let bytes = response.bytes().await.map_err(|e| format!("read application update: {e}"))?;
    if cancelled.load(Ordering::Acquire) { return Err("application update cancelled".into()); }
    if let Some(expected) = &release.sha256 {
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(expected.trim()) { return Err(format!("application update checksum mismatch: expected {expected}, got {actual}")); }
    }
    let _ = app.emit("app-update-progress", serde_json::json!({"phase":"finished","downloadedBytes":bytes.len(),"contentLength":total}));
    let root = std::env::temp_dir().join("flowix-updates");
    std::fs::create_dir_all(&root).map_err(|e| format!("create update directory: {e}"))?;
    let suffix = if cfg!(target_os = "windows") { "exe" } else if cfg!(target_os = "macos") { "dmg" } else { "AppImage" };
    let path = root.join(format!("Flowix-{}-{}.{}", manifest.version, std::process::id(), suffix));
    std::fs::write(&path, &bytes).map_err(|e| format!("stage application update: {e}"))?;
    launch_installer(&path)
}

fn updater_platform() -> &'static str { if cfg!(target_os = "macos") { "macos" } else if cfg!(target_os = "windows") { "windows" } else { "linux" } }
fn updater_target() -> &'static str { if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") { "darwin-aarch64" } else if cfg!(target_os = "macos") { "darwin-x86_64" } else if cfg!(target_os = "windows") { "windows-x86_64" } else { "linux-x86_64" } }

#[cfg(target_os = "windows")]
fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    // Tauri's NSIS updater expects /UPDATE so it can close the running
    // application, replace it, and relaunch it after installation.
    // Exit this process after handing the installer off; otherwise the
    // installed executable remains locked and NSIS cannot replace it.
    std::process::Command::new(path)
        .arg("/UPDATE")
        .spawn()
        .map_err(|e| format!("launch Windows installer: {e}"))?;
    std::process::exit(0);
}

#[cfg(not(target_os = "windows"))]
fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(path).spawn().map_err(|e| format!("open macOS installer: {e}"))?; }
    #[cfg(target_os = "linux")]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("prepare Linux update: {e}"))?; std::process::Command::new(path).spawn().map_err(|e| format!("launch Linux update: {e}"))?; }
    Ok(())
}
