use reqwest::Client;
use futures::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const UPDATE_ENDPOINT: &str = "https://download.flowix.cc/updater/";

#[derive(Default)]
pub struct AppUpdateState {
    active: Mutex<Option<std::sync::Arc<AtomicBool>>>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    platforms: std::collections::HashMap<String, PlatformRelease>,
}

#[derive(Debug, Deserialize)]
struct PlatformRelease {
    url: String,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug)]
struct ResolvedUpdate<'a> {
    version: semver::Version,
    release: &'a PlatformRelease,
}

#[tauri::command]
pub async fn check_app_update() -> Result<Option<AppUpdateInfo>, String> {
    let platform = updater_platform()?;
    let target = updater_target()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("create update client: {e}"))?;
    let manifest: Manifest = client
        .get(format!("{UPDATE_ENDPOINT}{platform}/latest.json"))
        .send()
        .await
        .map_err(|e| format!("download update manifest: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download update manifest: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse update manifest: {e}"))?;
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    Ok(
        resolve_update(&manifest, &current, target)?.map(|update| AppUpdateInfo {
            current_version: current.to_string(),
            version: update.version.to_string(),
            date: manifest.pub_date.clone(),
            body: manifest.notes.clone(),
        }),
    )
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "application update state is unavailable")?;
        if active.is_some() {
            return Err("an application update is already downloading".into());
        }
        *active = Some(cancelled.clone());
    }
    let result = download_and_launch(&app, &cancelled).await;
    if let Ok(mut active) = state.active.lock() {
        *active = None;
    }
    result
}

#[tauri::command]
pub fn cancel_app_update(state: State<'_, AppUpdateState>) -> Result<bool, String> {
    let active = state
        .active
        .lock()
        .map_err(|_| "application update state is unavailable")?;
    if let Some(flag) = active.as_ref() {
        flag.store(true, Ordering::Release);
        return Ok(true);
    }
    Ok(false)
}

async fn download_and_launch(app: &AppHandle, cancelled: &AtomicBool) -> Result<(), String> {
    let platform = updater_platform()?;
    let target = updater_target()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| format!("create update client: {e}"))?;
    let manifest: Manifest = client
        .get(format!("{UPDATE_ENDPOINT}{platform}/latest.json"))
        .send()
        .await
        .map_err(|e| format!("download update manifest: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download update manifest: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse update manifest: {e}"))?;
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    let update = resolve_update(&manifest, &current, target)?
        .ok_or_else(|| "no application update is available".to_string())?;
    let response = client
        .get(&update.release.url)
        .send()
        .await
        .map_err(|e| format!("download application update: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download application update: {e}"))?;
    let total = response.content_length();
    let _ = app.emit(
        "app-update-progress",
        serde_json::json!({"phase":"started","contentLength":total}),
    );
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();
    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::Acquire) {
            return Err("application update cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("read application update: {e}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        bytes.extend_from_slice(&chunk);
        if last_emit.elapsed() >= Duration::from_millis(100) {
            let _ = app.emit(
                "app-update-progress",
                serde_json::json!({"phase":"progress","downloadedBytes":downloaded,"contentLength":total}),
            );
            last_emit = Instant::now();
        }
    }
    let _ = app.emit(
        "app-update-progress",
        serde_json::json!({"phase":"progress","downloadedBytes":downloaded,"contentLength":total}),
    );
    if cancelled.load(Ordering::Acquire) {
        return Err("application update cancelled".into());
    }
    if let Some(expected) = &update.release.sha256 {
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            return Err(format!(
                "application update checksum mismatch: expected {expected}, got {actual}"
            ));
        }
    }
    let root = std::env::temp_dir().join("flowix-updates");
    std::fs::create_dir_all(&root).map_err(|e| format!("create update directory: {e}"))?;
    let suffix = if cfg!(target_os = "windows") {
        "exe"
    } else if cfg!(target_os = "macos") {
        "dmg"
    } else {
        "AppImage"
    };
    let path = root.join(format!(
        "Flowix-{}-{}.{}",
        update.version,
        std::process::id(),
        suffix
    ));
    std::fs::write(&path, &bytes).map_err(|e| format!("stage application update: {e}"))?;
    let _ = app.emit(
        "app-update-progress",
        serde_json::json!({"phase":"installing","downloadedBytes":bytes.len(),"contentLength":total}),
    );
    launch_installer(&path)
}

fn resolve_update<'a>(
    manifest: &'a Manifest,
    current: &semver::Version,
    target: &str,
) -> Result<Option<ResolvedUpdate<'a>>, String> {
    let available = semver::Version::parse(manifest.version.trim())
        .map_err(|e| format!("invalid update version: {e}"))?;
    if available <= *current {
        return Ok(None);
    }

    let release = manifest
        .platforms
        .get(target)
        .ok_or_else(|| format!("update manifest has no target {target}"))?;
    Ok(Some(ResolvedUpdate {
        version: available,
        release,
    }))
}

fn updater_platform() -> Result<&'static str, String> {
    updater_platform_for(std::env::consts::OS)
}

fn updater_platform_for(os: &str) -> Result<&'static str, String> {
    match os {
        "macos" => Ok("macos"),
        "windows" => Ok("windows"),
        "linux" => Ok("linux"),
        _ => Err(format!("application updates are unsupported on {os}")),
    }
}

fn updater_target() -> Result<&'static str, String> {
    updater_target_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn updater_target_for(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("macos", "aarch64") => Ok("darwin-aarch64"),
        ("macos", "x86_64") => Ok("darwin-x86_64"),
        ("windows", "x86_64") => Ok("windows-x86_64"),
        ("linux", "x86_64") => Ok("linux-x86_64"),
        _ => Err(format!(
            "application updates are unsupported on {os} {arch}"
        )),
    }
}

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
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("open macOS installer: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("prepare Linux update: {e}"))?;
        std::process::Command::new(path)
            .spawn()
            .map_err(|e| format!("launch Linux update: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn manifest(version: &str, targets: &[&str]) -> Manifest {
        Manifest {
            version: version.to_string(),
            notes: Some(format!("Flowix {version}")),
            pub_date: Some("2026-08-28T00:00:00Z".to_string()),
            platforms: targets
                .iter()
                .map(|target| {
                    (
                        (*target).to_string(),
                        PlatformRelease {
                            url: format!("https://download.flowix.cc/{target}"),
                            sha256: Some("checksum".to_string()),
                        },
                    )
                })
                .collect::<HashMap<_, _>>(),
        }
    }

    #[test]
    fn no_update_does_not_require_a_platform_artifact() {
        let current = semver::Version::parse("1.2.6").unwrap();

        assert!(
            resolve_update(&manifest("1.2.6", &[]), &current, "windows-x86_64")
                .unwrap()
                .is_none()
        );
        assert!(
            resolve_update(&manifest("1.2.5", &[]), &current, "darwin-aarch64")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn newer_update_requires_the_current_platform_artifact() {
        let current = semver::Version::parse("1.2.6").unwrap();
        let error =
            resolve_update(&manifest("1.2.7", &[]), &current, "windows-x86_64").unwrap_err();

        assert_eq!(error, "update manifest has no target windows-x86_64");
    }

    #[test]
    fn resolves_newer_updates_for_macos_and_windows_targets() {
        let current = semver::Version::parse("1.2.6").unwrap();
        let manifest = manifest(
            "1.2.7",
            &["darwin-aarch64", "darwin-x86_64", "windows-x86_64"],
        );

        for target in ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"] {
            let update = resolve_update(&manifest, &current, target)
                .unwrap()
                .unwrap();
            assert_eq!(update.version, semver::Version::parse("1.2.7").unwrap());
            assert!(update.release.url.ends_with(target));
        }
    }

    #[test]
    fn maps_supported_macos_and_windows_build_targets() {
        assert_eq!(updater_platform_for("macos").unwrap(), "macos");
        assert_eq!(updater_platform_for("windows").unwrap(), "windows");
        assert_eq!(
            updater_target_for("macos", "aarch64").unwrap(),
            "darwin-aarch64"
        );
        assert_eq!(
            updater_target_for("macos", "x86_64").unwrap(),
            "darwin-x86_64"
        );
        assert_eq!(
            updater_target_for("windows", "x86_64").unwrap(),
            "windows-x86_64"
        );
    }
}
