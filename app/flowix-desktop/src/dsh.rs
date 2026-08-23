//! Flowix-managed DeepSeek Harness runtime.
//!
//! DSH is deliberately distributed independently from the Tauri application.
//! The client downloads a signed, platform-specific archive, verifies it, and
//! installs it into a versioned directory.  The JSON-RPC host still runs as a
//! child process of Flowix; this keeps the existing stdio protocol and avoids
//! exposing a local TCP service.

use minisign_verify::{PublicKey, Signature};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::app::paths::get_app_data_path;

mod activation;
mod archive;

use activation::activate_current;
use archive::extract_archive;

pub const DSH_PROTOCOL_VERSION: u64 = 1;
const DEFAULT_PROFILE: &str = "flowix";
const DSH_DIR_NAME: &str = "dsh";
const MANIFEST_ENV: &str = "FLOWIX_DSH_MANIFEST_URL";
// Keep the DSH update channel on the independent download origin. The Pages
// site mirrors this file for compatibility, but DSH releases must not depend
// on a Flowix website deploy being present.
const DEFAULT_MANIFEST_URL: &str = "https://download.flowix-memo.com/dsh/latest.json";
pub const DSH_DOWNLOAD_PROGRESS_EVENT: &str = "dsh-download-progress";
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: u64 = 100_000;
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const REQUIRED_HOST_CAPABILITIES: &[&str] = &[
    "model-catalog",
    "model-discovery",
    "plugin-catalog",
    "runtime-profile",
];
static DSH_UPDATE_CANCELLED: AtomicBool = AtomicBool::new(false);
static DSH_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static DSH_DOWNLOAD_PROGRESS: OnceLock<Mutex<Option<DshDownloadProgress>>> = OnceLock::new();

/// Set FLOWIX_DSH_UPDATE_PUBLIC_KEY at compile time for production releases.
/// Development manifests may omit `signature`, but production manifests should
/// always include the full minisign signature text.
const DSH_UPDATE_PUBLIC_KEY: Option<&str> = option_env!("FLOWIX_DSH_UPDATE_PUBLIC_KEY");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshStatus {
    pub installed: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
    pub profile: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshDownloadProgress {
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
    pub resumed: bool,
}

fn dsh_operation_lock() -> &'static Mutex<()> {
    DSH_OPERATION_LOCK.get_or_init(|| Mutex::new(()))
}

fn try_acquire_operation_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    match dsh_operation_lock().try_lock() {
        Ok(guard) => Ok(guard),
        Err(std::sync::TryLockError::WouldBlock) => {
            Err("a DSH install, update, or uninstall is already in progress".to_string())
        }
        Err(std::sync::TryLockError::Poisoned(poisoned)) => {
            tracing::warn!("DSH operation lock was poisoned; recovering it");
            Ok(poisoned.into_inner())
        }
    }
}

fn download_progress_state() -> &'static Mutex<Option<DshDownloadProgress>> {
    DSH_DOWNLOAD_PROGRESS.get_or_init(|| Mutex::new(None))
}

/// Return the latest DSH download state so newly mounted windows can recover
/// progress after missing one or more native events.
pub fn download_progress() -> Option<DshDownloadProgress> {
    download_progress_state()
        .lock()
        .ok()
        .and_then(|value| value.clone())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshManifest {
    schema_version: u64,
    product: String,
    version: String,
    protocol_version: u64,
    #[serde(default)]
    min_flowix_version: Option<String>,
    platforms: HashMap<String, DshArtifact>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshArtifact {
    url: String,
    sha256: String,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    build_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshRuntimeMetadata {
    schema_version: u64,
    product: String,
    version: String,
    protocol_version: u64,
    build_id: String,
    target: String,
    includes_ui: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentDsh {
    version: String,
    target: String,
    build_id: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
    installed_at: String,
}

#[derive(Debug, Clone)]
struct DshInstallation {
    version: String,
    host_path: PathBuf,
    build_id: Option<String>,
    sha256: Option<String>,
}

pub fn status() -> DshStatus {
    match current_installation() {
        Some(installation) => DshStatus {
            installed: true,
            executable_path: Some(installation.host_path.display().to_string()),
            version: Some(installation.version.clone()),
            source: Some("flowix-managed".to_string()),
            profile: DEFAULT_PROFILE.to_string(),
            message: None,
        },
        None => DshStatus {
            installed: false,
            executable_path: None,
            version: None,
            source: None,
            profile: DEFAULT_PROFILE.to_string(),
            message: Some("DeepSeek Harness is not installed".to_string()),
        },
    }
}

/// Download and atomically install the current platform's DSH archive.
/// Network and archive work is intentionally synchronous; the Tauri command
/// runs it on a blocking worker so the UI thread remains responsive.
pub fn install_runtime_with_progress(app: Option<AppHandle>) -> Result<DshStatus, String> {
    let _operation_guard = try_acquire_operation_lock()?;
    DSH_UPDATE_CANCELLED.store(false, Ordering::Release);
    let result = install_runtime_inner(app.as_ref());
    if let Err(error) = &result {
        let phase = if is_cancelled_error(error) {
            "cancelled"
        } else {
            "failed"
        };
        emit_progress(app.as_ref(), phase, 0, None, false);
        tracing::warn!("DSH update failed: {error}");
    }
    result
}

pub fn cancel_update() {
    DSH_UPDATE_CANCELLED.store(true, Ordering::Release);
}

fn is_cancelled_error(error: &str) -> bool {
    error.contains("DSH download cancelled") || error.contains("DSH install cancelled")
}

fn check_cancelled() -> Result<(), String> {
    if DSH_UPDATE_CANCELLED.load(Ordering::Acquire) {
        return Err("DSH install cancelled".to_string());
    }
    Ok(())
}

/// Remove the Flowix-managed DSH runtime tree. `prepare` must have shut down
/// every dsh-host child process first; the caller is expected to invoke the
/// manager's `prepare_uninstall` before reaching this function. Only the
/// runtime tree under the Flowix data directory (`<app data>/dsh`) is removed
/// — user state in `~/.dsh/` (settings, sessions) is deliberately preserved.
pub fn uninstall_runtime() -> Result<DshStatus, String> {
    let _operation_guard = try_acquire_operation_lock()?;
    remove_runtime_root(&dsh_root()).map(|_| status())
}

/// Delegate profile dependency changes to the official `dsh plugin`
/// implementation embedded in the managed carrier. Flowix validates only the
/// narrow IPC surface; package resolution, reconciliation and install
/// semantics remain upstream-owned.
pub fn run_profile_plugin(
    dsh_home: &Path,
    action: &str,
    package: Option<&str>,
) -> Result<String, String> {
    let _operation_guard = try_acquire_operation_lock()?;
    let host = managed_host_path().ok_or("DeepSeek Harness runtime is not installed")?;
    let action = action.trim();
    if !matches!(action, "add" | "remove" | "update") {
        return Err("unsupported DSH plugin action".to_string());
    }
    let package = package.map(str::trim).filter(|value| !value.is_empty());
    if matches!(action, "add" | "remove") && package.is_none() {
        return Err(format!("DSH plugin {action} requires a package spec"));
    }
    if action == "update" && package.is_some() {
        return Err("DSH plugin update does not accept a package spec".to_string());
    }
    if action == "remove" && package.is_some_and(is_required_flowix_profile_bundle) {
        return Err("the official base and Flowix profile bundles cannot be removed".to_string());
    }
    if package.is_some_and(|value| value.starts_with('-') || value.contains('\0')) {
        return Err("invalid DSH plugin package spec".to_string());
    }

    let mut command = Command::new(&host);
    command
        .env_clear()
        .envs(dsh_plugin_environment())
        .env("DSH_EMBEDDED_CLI_MODE", "1")
        .env("DSH_HOME", dsh_home)
        .env(
            "FLOWIX_DSH_ROOT",
            host.parent()
                .ok_or("managed DSH host has no parent directory")?,
        )
        .args(["plugin", "--profile", DEFAULT_PROFILE, action]);
    if let Some(package) = package {
        command.arg(package);
    }
    let output = command
        .output()
        .map_err(|error| format!("start official dsh plugin command: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            format!("dsh plugin exited with {}", output.status)
        } else {
            stderr
        });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn is_required_flowix_profile_bundle(package: &str) -> bool {
    matches!(
        package,
        "@deepseek-ai/dsh-base" | "@flowix/dsh-flowix-bridge" | "dsh-flowix-memory"
    )
}

fn dsh_plugin_environment() -> HashMap<String, String> {
    const KEYS: &[&str] = &[
        "PATH",
        "Path",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "NODE_USE_ENV_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ];
    KEYS.iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| ((*key).to_string(), value))
        })
        .collect()
}

/// Delete the runtime tree. Failures keep the `installed` state consistent:
/// `current.json` is removed first, so a partially removed tree reports
/// `installed: false` and a later install fully replaces it.
fn remove_runtime_root(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    if !root.is_dir() {
        return Err(format!("DSH root {} is not a directory", root.display()));
    }
    let current_path = root.join("current.json");
    if current_path.exists() {
        fs::remove_file(&current_path).map_err(|e| format!("deactivate DSH installation: {e}"))?;
    }
    fs::remove_dir_all(root).map_err(|e| format!("remove DSH runtime directory: {e}"))?;
    Ok(())
}

fn install_runtime_inner(app: Option<&AppHandle>) -> Result<DshStatus, String> {
    emit_progress(app, "checking", 0, None, false);
    let manifest = fetch_manifest()?;
    check_cancelled()?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "unsupported DSH manifest schema {}",
            manifest.schema_version
        ));
    }
    if manifest.product != "flowix-dsh" {
        return Err("DSH manifest product mismatch".to_string());
    }
    if manifest.protocol_version != DSH_PROTOCOL_VERSION {
        return Err(format!(
            "DSH protocol mismatch: package={}, client={}",
            manifest.protocol_version, DSH_PROTOCOL_VERSION
        ));
    }
    validate_manifest_version(&manifest.version)?;
    if let Some(minimum) = manifest.min_flowix_version.as_deref() {
        if !version_is_at_least(crate::runtime_log::APP_VERSION, minimum)? {
            return Err(format!(
                "DSH {} requires Flowix >= {}, current Flowix is {}",
                manifest.version,
                minimum,
                crate::runtime_log::APP_VERSION
            ));
        }
    }
    let target = target_key();
    let artifact = manifest
        .platforms
        .get(target)
        .ok_or_else(|| format!("no DSH package is available for {target}"))?;

    let root = dsh_root();
    if let Some(current) = current_installation() {
        if version_is_at_least(&current.version, &manifest.version)?
            && (current.version != manifest.version || current_artifact_matches(&current, artifact))
        {
            emit_progress(app, "up-to-date", 0, None, false);
            return Ok(status());
        }
    }
    fs::create_dir_all(root.join("downloads"))
        .map_err(|e| format!("create DSH download directory: {e}"))?;
    let download = download_artifact(&artifact.url, &artifact.sha256, app, &root)?;
    if let Err(error) = check_cancelled() {
        let _ = fs::remove_file(&download.partial_path);
        return Err(error);
    }
    if let Err(error) = verify_artifact(&download.bytes, artifact) {
        let _ = fs::remove_file(&download.partial_path);
        return Err(error);
    }
    let _ = fs::remove_file(&download.partial_path);
    let versions = root.join("versions");
    fs::create_dir_all(&versions).map_err(|e| format!("create DSH directory: {e}"))?;
    let staging = versions.join(format!(".installing-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|e| format!("create DSH staging directory: {e}"))?;

    let result = extract_archive(&download.bytes, &staging)
        .and_then(|()| check_cancelled())
        .and_then(|()| publish_install(&root, &staging, &manifest, target, artifact));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|_| {
        emit_progress(app, "installed", 1, Some(1), false);
        status()
    })
}

fn current_artifact_matches(current: &DshInstallation, artifact: &DshArtifact) -> bool {
    // Installations created before checksum persistence are deliberately
    // re-downloaded once.  A matching version/build id alone cannot prove
    // that the bytes on disk are the bytes published in the manifest.
    current
        .sha256
        .as_deref()
        .is_some_and(|sha256| sha256.eq_ignore_ascii_case(artifact.sha256.trim()))
        && current.build_id == artifact.build_id
}

/// Used by the Rust host resolver. The path is versioned and never points at
/// a partially downloaded archive.
pub fn managed_host_path() -> Option<PathBuf> {
    current_installation().map(|installation| installation.host_path)
}

fn fetch_manifest() -> Result<DshManifest, String> {
    let url = std::env::var(MANIFEST_ENV).unwrap_or_else(|_| DEFAULT_MANIFEST_URL.to_string());
    let response = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("create DSH update client: {e}"))?
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("download DSH manifest: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "download DSH manifest from {url}: HTTP {}",
            response.status()
        ));
    }
    response
        .json::<DshManifest>()
        .map_err(|e| format!("parse DSH manifest: {e}"))
}

struct DownloadedArtifact {
    bytes: Vec<u8>,
    partial_path: PathBuf,
}

fn download_artifact(
    url: &str,
    expected_sha256: &str,
    app: Option<&AppHandle>,
    root: &Path,
) -> Result<DownloadedArtifact, String> {
    let normalized_hash = expected_sha256.trim().to_ascii_lowercase();
    if normalized_hash.len() != 64 || !normalized_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("DSH manifest contains an invalid SHA-256 digest".to_string());
    }
    let partial_path = root
        .join("downloads")
        .join(format!("{normalized_hash}.part"));
    let mut existing = fs::metadata(&partial_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if existing > MAX_DOWNLOAD_BYTES {
        fs::remove_file(&partial_path)
            .map_err(|e| format!("remove oversized DSH partial download: {e}"))?;
        existing = 0;
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| format!("create DSH download client: {e}"))?;
    let mut response = request_artifact(&client, url, existing)?;
    if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && existing > 0 {
        let _ = fs::remove_file(&partial_path);
        existing = 0;
        response = request_artifact(&client, url, 0)?;
    }
    let resumed = existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if existing > 0 && !resumed {
        existing = 0;
        response = request_artifact(&client, url, 0)?;
    }
    if !response.status().is_success() {
        return Err(format!("download DSH package: HTTP {}", response.status()));
    }
    let total_bytes = response
        .content_length()
        .map(|length| length.saturating_add(existing));
    let mut downloaded = existing;
    let mut file = if existing > 0 {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&partial_path)
    } else {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&partial_path)
    }
    .map_err(|e| format!("open DSH partial download: {e}"))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut last_emit = Instant::now();
    emit_progress(app, "downloading", downloaded, total_bytes, resumed);
    loop {
        if DSH_UPDATE_CANCELLED.load(Ordering::Acquire) {
            emit_progress(app, "cancelled", downloaded, total_bytes, resumed);
            return Err(
                "DSH download cancelled; the partial download was kept for resume".to_string(),
            );
        }
        let count = response
            .read(&mut buffer)
            .map_err(|e| format!("read DSH package: {e}"))?;
        if count == 0 {
            break;
        }
        downloaded = downloaded.saturating_add(count as u64);
        if downloaded > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "DSH package exceeds {} MiB limit",
                MAX_DOWNLOAD_BYTES / 1024 / 1024
            ));
        }
        file.write_all(&buffer[..count])
            .map_err(|e| format!("write DSH partial download: {e}"))?;
        if last_emit.elapsed() >= Duration::from_millis(100) {
            emit_progress(app, "downloading", downloaded, total_bytes, resumed);
            last_emit = Instant::now();
        }
    }
    file.flush()
        .map_err(|e| format!("flush DSH partial download: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("sync DSH partial download: {e}"))?;
    emit_progress(app, "downloaded", downloaded, total_bytes, resumed);
    let bytes = fs::read(&partial_path).map_err(|e| format!("read completed DSH package: {e}"))?;
    if bytes.is_empty() {
        return Err("downloaded DSH package is empty".to_string());
    }
    Ok(DownloadedArtifact {
        bytes,
        partial_path,
    })
}

fn request_artifact(
    client: &Client,
    url: &str,
    existing: u64,
) -> Result<reqwest::blocking::Response, String> {
    let mut request = client.get(url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    request
        .send()
        .map_err(|e| format!("download DSH package: {e}"))
}

fn emit_progress(
    app: Option<&AppHandle>,
    phase: &str,
    downloaded: u64,
    total: Option<u64>,
    resumed: bool,
) {
    let percent = total
        .filter(|value| *value > 0)
        .map(|value| ((downloaded.saturating_mul(100) / value).min(100)) as u8);
    let progress = DshDownloadProgress {
        phase: phase.to_string(),
        downloaded_bytes: downloaded,
        total_bytes: total,
        percent,
        resumed,
    };
    if let Ok(mut value) = download_progress_state().lock() {
        *value = Some(progress.clone());
    }
    if let Some(app) = app {
        let _ = app.emit(DSH_DOWNLOAD_PROGRESS_EVENT, progress);
    }
}

fn version_is_at_least(current: &str, required: &str) -> Result<bool, String> {
    let current = semver::Version::parse(current.trim())
        .map_err(|e| format!("invalid DSH version {current}: {e}"))?;
    let required = semver::Version::parse(required.trim())
        .map_err(|e| format!("invalid required DSH version {required}: {e}"))?;
    Ok(current >= required)
}

fn validate_manifest_version(version: &str) -> Result<(), String> {
    if version.trim() != version {
        return Err("DSH manifest version must not contain surrounding whitespace".to_string());
    }
    semver::Version::parse(version)
        .map(|_| ())
        .map_err(|e| format!("invalid DSH manifest version {version}: {e}"))
}

fn verify_artifact(bytes: &[u8], artifact: &DshArtifact) -> Result<(), String> {
    let digest = format!("{:x}", Sha256::digest(bytes));
    if !digest.eq_ignore_ascii_case(artifact.sha256.trim()) {
        return Err(format!(
            "DSH package checksum mismatch: expected {}, got {}",
            artifact.sha256, digest
        ));
    }
    if let Some(signature_text) = artifact.signature.as_deref() {
        match DSH_UPDATE_PUBLIC_KEY {
            Some(public_key) => {
                let key = PublicKey::decode(public_key)
                    .map_err(|e| format!("parse DSH update public key: {e}"))?;
                let signature = Signature::decode(signature_text)
                    .map_err(|e| format!("parse DSH package signature: {e}"))?;
                key.verify(bytes, &signature, false)
                    .map_err(|e| format!("verify DSH package signature: {e}"))?;
            }
            None if cfg!(debug_assertions) => {
                // Dev builds can consume the published signed manifest while
                // the signing public key is supplied separately for release
                // builds. SHA-256 is still checked above; production builds
                // continue to reject signed packages without the public key.
                tracing::warn!(
                    "DSH package signature was not cryptographically verified: no public key in dev build"
                );
            }
            None => {
                return Err(
                    "DSH package is signed but this Flowix build has no DSH public key".to_string(),
                );
            }
        }
    } else if DSH_UPDATE_PUBLIC_KEY.is_some() {
        return Err(
            "DSH package is unsigned but this is a signature-enforcing Flowix build".to_string(),
        );
    }
    Ok(())
}

fn publish_install(
    root: &Path,
    staging: &Path,
    manifest: &DshManifest,
    target: &str,
    artifact: &DshArtifact,
) -> Result<(), String> {
    validate_runtime_metadata(staging, manifest, target, artifact)?;
    let host = staging.join(if cfg!(windows) {
        "dsh-host.exe"
    } else {
        "dsh-host"
    });
    if !host.is_file() {
        return Err("DSH archive does not contain dsh-host".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&host)
            .map_err(|e| format!("inspect dsh-host: {e}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&host, permissions)
            .map_err(|e| format!("make dsh-host executable: {e}"))?;
    }
    let version_root = root.join("versions").join(&manifest.version);
    // Keep the version that was active when this upgrade started. The new
    // archive is fully health-checked before current.json changes, so a failed
    // activation continues to use it; after a successful activation it remains
    // available as the single rollback candidate for a later explicit policy.
    let previous_version_root =
        active_version_root(root).filter(|previous| previous != &version_root);
    let backup = if version_root.exists() {
        let backup = version_root.with_file_name(format!(".replaced-{}", uuid::Uuid::new_v4()));
        fs::rename(&version_root, &backup)
            .map_err(|e| format!("stage previous DSH version: {e}"))?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = fs::rename(staging, &version_root) {
        if let Some(previous) = backup.as_ref() {
            let _ = fs::rename(previous, &version_root);
        }
        return Err(format!("publish DSH version: {error}"));
    }
    if let Err(error) = health_check(&version_root.join(if cfg!(windows) {
        "dsh-host.exe"
    } else {
        "dsh-host"
    })) {
        let _ = fs::remove_dir_all(&version_root);
        if let Some(previous) = backup.as_ref() {
            let _ = fs::rename(previous, &version_root);
        }
        return Err(error);
    }
    let current = CurrentDsh {
        version: manifest.version.clone(),
        target: target.to_string(),
        build_id: artifact.build_id.clone(),
        sha256: Some(artifact.sha256.trim().to_ascii_lowercase()),
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    let current_path = root.join("current.json");
    let temp_path = root.join(format!(".current-{}.json", uuid::Uuid::new_v4()));
    let body =
        serde_json::to_vec_pretty(&current).map_err(|e| format!("serialize DSH state: {e}"))?;
    if let Err(error) = fs::write(&temp_path, body) {
        let _ = fs::remove_dir_all(&version_root);
        if let Some(previous) = backup.as_ref() {
            let _ = fs::rename(previous, &version_root);
        }
        return Err(format!("write DSH state: {error}"));
    }
    if let Err(error) = activate_current(&temp_path, &current_path) {
        let _ = fs::remove_file(&temp_path);
        let _ = fs::remove_dir_all(&version_root);
        if let Some(previous) = backup.as_ref() {
            let _ = fs::rename(previous, &version_root);
        }
        return Err(error);
    }
    if let Some(previous) = backup {
        if let Err(error) = fs::remove_dir_all(&previous) {
            // The active marker already points at the new, healthy version;
            // leave cleanup to the next install rather than reporting a
            // successful activation as a failed upgrade.
            tracing::warn!(path = %previous.display(), %error, "failed to remove replaced DSH version");
        }
    }
    cleanup_old_versions(root, &version_root, previous_version_root.as_deref());
    Ok(())
}

fn validate_runtime_metadata(
    staging: &Path,
    manifest: &DshManifest,
    target: &str,
    artifact: &DshArtifact,
) -> Result<(), String> {
    let path = staging.join("dsh-runtime.json");
    let metadata: DshRuntimeMetadata = serde_json::from_str(
        &fs::read_to_string(&path)
            .map_err(|e| format!("read DSH archive metadata {}: {e}", path.display()))?,
    )
    .map_err(|e| format!("parse DSH archive metadata: {e}"))?;
    if metadata.schema_version != 1 || metadata.product != "flowix-dsh" {
        return Err("DSH archive metadata schema or product mismatch".to_string());
    }
    if metadata.version != manifest.version {
        return Err(format!(
            "DSH archive version mismatch: manifest={}, archive={}",
            manifest.version, metadata.version
        ));
    }
    if metadata.protocol_version != manifest.protocol_version
        || metadata.protocol_version != DSH_PROTOCOL_VERSION
    {
        return Err(format!(
            "DSH archive protocol mismatch: manifest={}, archive={}, client={}",
            manifest.protocol_version, metadata.protocol_version, DSH_PROTOCOL_VERSION
        ));
    }
    if target != target_key() || metadata.target != runtime_target_key() {
        return Err(format!(
            "DSH archive target mismatch: manifest={}, archive={}, client={}/{}",
            target,
            metadata.target,
            target_key(),
            runtime_target_key()
        ));
    }
    if metadata.includes_ui {
        return Err("DSH archive unexpectedly includes UI assets".to_string());
    }
    let manifest_build_id = artifact
        .build_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("DSH manifest artifact is missing buildId")?;
    if metadata.build_id.trim().is_empty() || metadata.build_id != manifest_build_id {
        return Err(format!(
            "DSH archive buildId mismatch: manifest={}, archive={}",
            manifest_build_id, metadata.build_id
        ));
    }
    Ok(())
}

fn active_version_root(root: &Path) -> Option<PathBuf> {
    let current: CurrentDsh =
        serde_json::from_str(&fs::read_to_string(root.join("current.json")).ok()?).ok()?;
    validate_manifest_version(&current.version).ok()?;
    Some(root.join("versions").join(current.version))
}

fn cleanup_old_versions(
    root: &Path,
    current_version_root: &Path,
    previous_version_root: Option<&Path>,
) {
    let versions = root.join("versions");
    let entries = match fs::read_dir(&versions) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(path = %versions.display(), %error, "failed to inspect old DSH versions");
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == current_version_root || previous_version_root == Some(path.as_path()) {
            continue;
        }
        let result = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        if let Err(error) = result {
            tracing::warn!(path = %path.display(), %error, "failed to remove old DSH version");
        }
    }
}

fn health_check(host: &Path) -> Result<(), String> {
    let root = host
        .parent()
        .ok_or_else(|| "DSH host has no parent directory".to_string())?;
    let session_root = root.join(format!(".health-check-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&session_root)
        .map_err(|e| format!("create DSH health-check directory: {e}"))?;
    let dsh_home = session_root.join("dsh-home");
    fs::create_dir_all(&dsh_home).map_err(|e| format!("create DSH health-check home: {e}"))?;
    let settings_path = dsh_home.join("settings.yaml");
    let credentials_path = dsh_home.join(".credentials.yaml");
    fs::write(&settings_path, b"llm-pi-ai:\n  providers: {}\n")
        .map_err(|e| format!("write DSH health-check settings: {e}"))?;
    fs::write(&credentials_path, b"DSH_API_KEY: health-check\n")
        .map_err(|e| format!("write DSH health-check credentials: {e}"))?;
    let mut child = Command::new(host)
        .env("FLOWIX_DSH_SESSION_ROOT", &session_root)
        .env("DSH_HOME", &dsh_home)
        .env("DSH_SETTINGS_PATH", &settings_path)
        .env("DSH_CREDENTIALS_PATH", &credentials_path)
        .env("FLOWIX_DSH_ROOT", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("start DSH health check: {e}"))?;
    let result = (|| -> Result<(), String> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or("DSH health-check stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("DSH health-check stdout unavailable")?;
        let (line_tx, line_rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line_tx
                    .send(line.map_err(|e| format!("read DSH health check: {e}")))
                    .is_err()
                {
                    break;
                }
            }
        });
        let initialize = rpc_health_request(
            &mut stdin,
            &line_rx,
            1,
            "host.initialize",
            serde_json::json!({ "protocolVersion": DSH_PROTOCOL_VERSION }),
        )?;
        let result = initialize.get("result");
        let protocol_ok = result
            .and_then(|value| value.get("protocolVersion"))
            .and_then(serde_json::Value::as_u64)
            == Some(DSH_PROTOCOL_VERSION);
        let capabilities_ok = result
            .and_then(|value| value.get("capabilities"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|capabilities| {
                REQUIRED_HOST_CAPABILITIES.iter().all(|required| {
                    capabilities
                        .iter()
                        .any(|capability| capability.as_str() == Some(required))
                })
            });
        if initialize.get("error").is_some() || !protocol_ok || !capabilities_ok {
            return Err("DSH host.initialize health check failed".to_string());
        }
        let thread_id = "flowix-install-health-check";
        rpc_health_request(
            &mut stdin,
            &line_rx,
            2,
            "runtime.ensure",
            serde_json::json!({
                "threadId": thread_id,
                "sessionId": "flowix-install-health-session",
                "cwd": root,
                "workspacePaths": [],
                "provider": "openai",
                "providerName": "install-health-check",
                "apiProtocol": "openai-completions",
                "apiKeyEnv": "DSH_API_KEY",
                "baseUrl": "http://127.0.0.1:9/v1",
                "model": "health-check-model",
                "agentPreset": "minimal",
                "permissionMode": "read-only"
            }),
        )?;
        let bridge = rpc_health_request(
            &mut stdin,
            &line_rx,
            3,
            "runtime.bridge.capabilities",
            serde_json::json!({ "threadId": thread_id }),
        )?;
        let bridge_capabilities_ok = bridge
            .get("result")
            .and_then(|value| value.get("capabilities"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|capabilities| {
                ["runtime-events", "session-control"]
                    .iter()
                    .all(|required| {
                        capabilities
                            .iter()
                            .any(|capability| capability.as_str() == Some(required))
                    })
            });
        if !bridge_capabilities_ok {
            return Err("DSH runtime bridge health check failed".to_string());
        }
        rpc_health_request(
            &mut stdin,
            &line_rx,
            4,
            "runtime.dispose",
            serde_json::json!({ "threadId": thread_id }),
        )?;
        rpc_health_request(
            &mut stdin,
            &line_rx,
            5,
            "host.shutdown",
            serde_json::json!({}),
        )?;
        Ok(())
    })();
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_dir_all(&session_root);
    result
}

fn rpc_health_request(
    stdin: &mut impl Write,
    lines: &mpsc::Receiver<Result<String, String>>,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    writeln!(stdin, "{request}").map_err(|e| format!("write DSH {method} health check: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("flush DSH {method} health check: {e}"))?;
    let deadline = Instant::now() + HEALTH_CHECK_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = lines
            .recv_timeout(remaining)
            .map_err(|_| format!("DSH {method} health check timed out"))??;
        let frame: serde_json::Value = serde_json::from_str(line.trim())
            .map_err(|e| format!("parse DSH {method} health check: {e}"))?;
        if frame.get("id").and_then(serde_json::Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = frame.get("error") {
            let message = error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown JSON-RPC error");
            return Err(format!("DSH {method} health check failed: {message}"));
        }
        return Ok(frame);
    }
}

fn current_installation() -> Option<DshInstallation> {
    let root = dsh_root();
    let current: CurrentDsh =
        serde_json::from_str(&fs::read_to_string(root.join("current.json")).ok()?).ok()?;
    validate_manifest_version(&current.version).ok()?;
    if current.target != target_key() {
        return None;
    }
    let host = root
        .join("versions")
        .join(&current.version)
        .join(if cfg!(windows) {
            "dsh-host.exe"
        } else {
            "dsh-host"
        });
    host.is_file().then_some(DshInstallation {
        version: current.version,
        host_path: host,
        build_id: current.build_id,
        sha256: current.sha256,
    })
}

fn dsh_root() -> PathBuf {
    get_app_data_path().join(DSH_DIR_NAME)
}

fn target_key() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "darwin-aarch64"
        } else {
            "darwin-x86_64"
        }
    } else if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") {
            "linux-aarch64"
        } else {
            "linux-x86_64"
        }
    } else {
        "unknown"
    }
}

fn runtime_target_key() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "node24-macos-arm64"
        } else {
            "node24-macos-x64"
        }
    } else if cfg!(target_os = "windows") {
        "node24-windows-x64"
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") {
            "node24-linux-arm64"
        } else {
            "node24-linux-x64"
        }
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::{
        archive::safe_archive_path, validate_manifest_version, version_is_at_least, DshArtifact,
        DshManifest,
    };
    use std::collections::HashMap;
    use std::path::Path;

    #[test]
    fn protects_only_flowix_profile_requirements_from_managed_removal() {
        assert!(super::is_required_flowix_profile_bundle(
            "@deepseek-ai/dsh-base"
        ));
        assert!(super::is_required_flowix_profile_bundle(
            "@flowix/dsh-flowix-bridge"
        ));
        assert!(super::is_required_flowix_profile_bundle(
            "dsh-flowix-memory"
        ));
        assert!(!super::is_required_flowix_profile_bundle(
            "community-dsh-plugin"
        ));
    }

    #[test]
    fn rejects_archive_traversal() {
        assert!(safe_archive_path(Path::new("../escape")).is_err());
        assert!(safe_archive_path(Path::new("/absolute")).is_err());
        assert!(safe_archive_path(Path::new("dsh-host")).is_ok());
    }

    #[test]
    fn compares_dsh_versions_before_downloading() {
        assert!(version_is_at_least("1.2.0", "1.1.9").unwrap());
        assert!(!version_is_at_least("1.2.0", "1.2.1").unwrap());
        assert!(version_is_at_least("1.2.0", "1.2.0").unwrap());
        assert!(version_is_at_least("1.2.0", "bad-version").is_err());
    }

    #[test]
    fn rejects_unsafe_manifest_versions_before_path_use() {
        assert!(validate_manifest_version("1.2.3").is_ok());
        assert!(validate_manifest_version("1.2.3/../../escape").is_err());
        assert!(validate_manifest_version(" 1.2.3").is_err());
    }

    #[test]
    fn uninstall_removes_the_runtime_tree_and_is_idempotent() {
        let root = tempdir_runtime_root("uninstall-removes");
        let versions = root.join("versions").join("1.0.0");
        std::fs::create_dir_all(&versions).unwrap();
        std::fs::write(versions.join("dsh-host"), b"binary").unwrap();
        std::fs::create_dir_all(root.join("downloads")).unwrap();
        std::fs::write(root.join("downloads/leftover.part"), b"partial").unwrap();
        std::fs::write(
            root.join("current.json"),
            br#"{"version":"1.0.0","target":"test","buildId":null,"installedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();

        super::remove_runtime_root(&root).unwrap();
        assert!(!root.exists());

        // A second uninstall of an already-clean system is a no-op, not an error.
        super::remove_runtime_root(&root).unwrap();
    }

    #[test]
    fn uninstall_deactivates_before_deleting_so_partial_failures_report_uninstalled() {
        let root = tempdir_runtime_root("uninstall-partial");
        std::fs::create_dir_all(root.join("versions")).unwrap();
        std::fs::write(root.join("current.json"), "not-json").unwrap();

        super::remove_runtime_root(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn uninstall_removes_a_runtime_tree_without_a_current_marker() {
        let root = tempdir_runtime_root("uninstall-without-marker");
        std::fs::create_dir_all(root.join("versions/1.0.0")).unwrap();
        std::fs::write(root.join("versions/1.0.0/dsh-host"), b"binary").unwrap();

        super::remove_runtime_root(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn legacy_installation_without_checksum_is_not_reused() {
        let current = super::DshInstallation {
            version: "1.0.0".to_string(),
            host_path: std::path::PathBuf::from("dsh-host"),
            build_id: Some("same-build".to_string()),
            sha256: None,
        };
        let artifact = DshArtifact {
            url: "https://example.test/dsh.tar.gz".to_string(),
            sha256: "0".repeat(64),
            signature: None,
            build_id: Some("same-build".to_string()),
        };

        assert!(!super::current_artifact_matches(&current, &artifact));
    }

    #[test]
    fn cleanup_old_versions_keeps_the_active_and_previous_versions() {
        let root = tempdir_runtime_root("cleanup-old-versions");
        let versions = root.join("versions");
        let active = versions.join("2.0.0");
        let previous = versions.join("1.0.0");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&previous).unwrap();
        std::fs::create_dir_all(versions.join("0.9.0")).unwrap();
        std::fs::create_dir_all(versions.join(".replaced-old")).unwrap();
        std::fs::write(versions.join(".installing-stale"), b"stale").unwrap();

        super::cleanup_old_versions(&root, &active, Some(&previous));

        assert!(active.exists());
        assert!(previous.exists());
        assert!(!versions.join("0.9.0").exists());
        assert!(!versions.join(".replaced-old").exists());
        assert!(!versions.join(".installing-stale").exists());
    }

    #[test]
    fn activation_replaces_the_previous_marker() {
        let root = tempdir_runtime_root("activation");
        let current = root.join("current.json");
        let temp = root.join(".current-new.json");
        std::fs::write(&current, b"old").unwrap();
        std::fs::write(&temp, b"new").unwrap();

        super::activation::activate_current(&temp, &current).unwrap();
        assert_eq!(std::fs::read(&current).unwrap(), b"new");
        assert!(!temp.exists());
    }

    #[cfg(unix)]
    #[test]
    fn reinstalling_existing_version_replaces_the_previous_directory() {
        let root = tempdir_runtime_root("reinstall-existing");
        let version = "1.0.0";
        let version_root = root.join("versions").join(version);
        std::fs::create_dir_all(&version_root).unwrap();
        std::fs::write(version_root.join("dsh-host"), b"old-host").unwrap();

        let staging = root.join("versions").join(".installing-test");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(
            staging.join("dsh-host"),
            b"#!/bin/sh\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1,\"buildId\":\"test-build\",\"capabilities\":[\"model-catalog\",\"model-discovery\",\"plugin-catalog\",\"runtime-profile\"]}}'\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"sessionId\":\"health\",\"generation\":1}}'\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"capabilities\":[\"runtime-events\",\"session-control\"]}}'\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"disposed\":true}}'\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{\"ok\":true}}'\n",
        )
        .unwrap();
        write_test_runtime_metadata(&staging, version, "test-build");

        let manifest = DshManifest {
            schema_version: 1,
            product: "flowix-dsh".to_string(),
            version: version.to_string(),
            protocol_version: super::DSH_PROTOCOL_VERSION,
            min_flowix_version: None,
            platforms: HashMap::new(),
        };
        let artifact = DshArtifact {
            url: "https://example.test/dsh.tar.gz".to_string(),
            sha256: "0".repeat(64),
            signature: None,
            build_id: Some("test-build".to_string()),
        };

        super::publish_install(&root, &staging, &manifest, super::target_key(), &artifact).unwrap();
        assert!(std::fs::read(version_root.join("dsh-host"))
            .unwrap()
            .starts_with(b"#!/bin/sh"));
        assert!(!root.join("versions").join(".installing-test").exists());
        assert!(root.join("current.json").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn failed_health_check_restores_the_previous_version_directory() {
        let root = tempdir_runtime_root("reinstall-rollback");
        let version = "1.0.0";
        let version_root = root.join("versions").join(version);
        std::fs::create_dir_all(&version_root).unwrap();
        std::fs::write(version_root.join("dsh-host"), b"old-host").unwrap();

        let staging = root.join("versions").join(".installing-test");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(
            staging.join("dsh-host"),
            b"#!/bin/sh\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":999}}'\nread request\n",
        )
        .unwrap();
        write_test_runtime_metadata(&staging, version, "test-build");

        let manifest = DshManifest {
            schema_version: 1,
            product: "flowix-dsh".to_string(),
            version: version.to_string(),
            protocol_version: super::DSH_PROTOCOL_VERSION,
            min_flowix_version: None,
            platforms: HashMap::new(),
        };
        let artifact = DshArtifact {
            url: "https://example.test/dsh.tar.gz".to_string(),
            sha256: "0".repeat(64),
            signature: None,
            build_id: Some("test-build".to_string()),
        };

        assert!(
            super::publish_install(&root, &staging, &manifest, super::target_key(), &artifact,)
                .is_err()
        );
        assert_eq!(
            std::fs::read(version_root.join("dsh-host")).unwrap(),
            b"old-host"
        );
    }

    fn tempdir_runtime_root(prefix: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("flowix-dsh-test-{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_test_runtime_metadata(root: &Path, version: &str, build_id: &str) {
        std::fs::write(
            root.join("dsh-runtime.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "product": "flowix-dsh",
                "version": version,
                "protocolVersion": super::DSH_PROTOCOL_VERSION,
                "buildId": build_id,
                "target": super::runtime_target_key(),
                "includesUi": false,
            }))
            .unwrap(),
        )
        .unwrap();
    }
}
