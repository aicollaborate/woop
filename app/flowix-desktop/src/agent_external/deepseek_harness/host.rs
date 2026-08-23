use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::protocol;
use crate::agent_external::shared::{
    configure_unix_process_group, kill_child_tree, read_capped_line, MAX_STDOUT_LINE_BYTES,
};
use crate::config::user::atomic_write_yaml;

type RouteKey = (String, String);
type PendingSender = oneshot::Sender<Result<Value, String>>;

pub struct DshHostClient {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<HashMap<u64, PendingSender>>>,
    routes: Arc<Mutex<HashMap<RouteKey, mpsc::UnboundedSender<Value>>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl DshHostClient {
    pub async fn spawn(
        session_root: &Path,
        dsh_home: &Path,
        settings_path: &Path,
        credentials_path: &Path,
        plugin_settings_path: &Path,
    ) -> Result<Arc<Self>, String> {
        let (mut command, host_root) = resolve_host_command()?;
        if let Some(build_id) = sidecar_build_id() {
            command.env("FLOWIX_DSH_BUILD_ID", build_id);
        }
        command
            .env_clear()
            .envs(allowed_parent_environment())
            .env("FLOWIX_DSH_SESSION_ROOT", session_root)
            .env("DSH_HOME", dsh_home)
            .env("FLOWIX_DSH_ROOT", &host_root)
            .env("DSH_SETTINGS_PATH", settings_path)
            .env("DSH_CREDENTIALS_PATH", credentials_path)
            .env("FLOWIX_DSH_PLUGIN_SETTINGS_PATH", plugin_settings_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cli) = bundled_flowix_cli_path() {
            command.env("FLOWIX_DSH_MCP_CLI", cli);
        }
        // dsh-host resolves the runtime path itself by scanning the directory
        // that holds its own executable. The launcher no longer hands it a
        // hard-coded path so an end-user cannot silently redirect the
        // runtime through an env override.
        configure_unix_process_group(&mut command);
        crate::process_window::hide_command_window(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start dsh-host: {error}"))?;
        let stdin = child.stdin.take().ok_or("dsh-host stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("dsh-host stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("dsh-host stderr unavailable")?;
        let client = Arc::new(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            routes: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });
        spawn_stdout_reader(client.clone(), BufReader::new(stdout));
        spawn_stderr_reader(BufReader::new(stderr));
        let request = protocol::initialize_request(client.next_request_id());
        let result = client.request_value(request).await?;
        if result.get("protocolVersion").and_then(Value::as_u64)
            != Some(protocol::HOST_PROTOCOL_VERSION)
        {
            client.kill().await;
            return Err("dsh-host protocol version mismatch".to_string());
        }
        let capabilities = result
            .get("capabilities")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "dsh-host is outdated: host.initialize did not advertise capabilities".to_string()
            });
        let capabilities = match capabilities {
            Ok(value) => value,
            Err(error) => {
                client.kill().await;
                return Err(error);
            }
        };

        // The host embeds the build identity that was baked into the source
        // bundle. The launcher reads it back so a binary built against one
        // dsh-host/dsh-runtime pair cannot be silently replaced with a
        // mismatched sidecar from a stale Cargo target directory.
        let host_build_id = result
            .get("buildId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let host_build_id = match host_build_id {
            Some(value) => value,
            None => {
                client.kill().await;
                return Err(
                    "dsh-host buildId missing from initialize result; rebuild dsh-host".to_string(),
                );
            }
        };
        let expected_build_id = std::env::var("FLOWIX_DSH_BUILD_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Some(expected) = expected_build_id {
            if expected != host_build_id {
                client.kill().await;
                return Err(format!(
                    "dsh-host buildId mismatch (host={host_build_id}, launcher={expected}); \
                     the sidecar pair is out of sync, rebuild via `pnpm dsh:build`"
                ));
            }
        } else {
            tracing::info!(build_id = %host_build_id, "dsh-host reported build identity");
        }
        for required in [
            "model-catalog",
            "model-discovery",
            "plugin-catalog",
            "runtime-profile",
        ] {
            if !capabilities
                .iter()
                .any(|value| value.as_str() == Some(required))
            {
                client.kill().await;
                return Err(format!(
                    "dsh-host is outdated: missing {required} capability; rebuild the host"
                ));
            }
        }
        Ok(client)
    }

    pub fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn request_value(&self, value: Value) -> Result<Value, String> {
        if self.is_closed() {
            return Err("dsh-host is not running".to_string());
        }
        let id = value
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("dsh-host request has no numeric id")?;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        let line = format!("{}\n", value);
        if let Err(error) = self.stdin.lock().await.write_all(line.as_bytes()).await {
            self.pending.lock().await.remove(&id);
            return Err(format!("failed to write dsh-host request: {error}"));
        }
        match tokio::time::timeout(std::time::Duration::from_secs(125), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("dsh-host response channel closed".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("dsh-host request timed out".to_string())
            }
        }
    }

    pub async fn subscribe(&self, thread_id: &str, run_id: &str) -> mpsc::UnboundedReceiver<Value> {
        let (sender, receiver) = mpsc::unbounded_channel();
        self.routes
            .lock()
            .await
            .insert((thread_id.to_string(), run_id.to_string()), sender);
        receiver
    }

    pub async fn unsubscribe(&self, thread_id: &str, run_id: &str) {
        self.routes
            .lock()
            .await
            .remove(&(thread_id.to_string(), run_id.to_string()));
    }

    pub async fn shutdown(&self) {
        let request = protocol::shutdown_request(self.next_request_id());
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            self.request_value(request),
        )
        .await;
        self.kill().await;
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    async fn kill(&self) {
        self.closed.store(true, Ordering::Release);
        let mut child = self.child.lock().await;
        kill_child_tree(&mut child, "dsh-host", "shared-host").await;
    }
}

/// Bridge the existing Flowix secret store into the DSH-owned credentials
/// document. The runtime never receives the value in its environment; the
/// upstream credentials-local plugin reads this file and resolves the
/// reference per request. This bridge is temporary until Flowix can call a
/// first-class DSH credentials UI/API without starting a separate web host.
pub(crate) fn sync_credential_file(
    path: &Path,
    reference: &str,
    value: &str,
) -> Result<(), String> {
    if value.trim().is_empty() {
        return Ok(());
    }
    if !is_credential_reference(reference) {
        return Err("invalid DSH credential reference".to_string());
    }
    let Some(parent) = path.parent() else {
        return Err("DSH credentials path has no parent directory".to_string());
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create DSH credentials directory: {error}"))?;
    let lock_path = path.with_extension("yaml.flowix-lock");
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| format!("failed to open DSH credentials lock: {error}"))?;
    set_owner_only_file(&lock_path);
    fs2::FileExt::lock_exclusive(&lock)
        .map_err(|error| format!("failed to lock DSH credentials document: {error}"))?;

    let mut credentials = match fs::read_to_string(path) {
        Ok(content) if !content.trim().is_empty() => {
            serde_yaml::from_str::<BTreeMap<String, String>>(&content)
                .map_err(|_| "DSH credentials document is invalid".to_string())?
        }
        Ok(_) => BTreeMap::new(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => return Err(format!("failed to read DSH credentials document: {error}")),
    };
    credentials.insert(reference.to_string(), value.to_string());
    let content = serde_yaml::to_string(&credentials)
        .map_err(|_| "failed to serialize DSH credentials document".to_string())?;
    atomic_write_yaml(path, &content)
        .map_err(|error| format!("failed to write DSH credentials document: {error}"))?;
    Ok(())
}

fn is_credential_reference(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

#[cfg(unix)]
fn set_owner_only_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_owner_only_file(_path: &Path) {}

fn spawn_stdout_reader(
    client: Arc<DshHostClient>,
    mut reader: BufReader<tokio::process::ChildStdout>,
) {
    tokio::spawn(async move {
        loop {
            let next = read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await;
            let Some((line, truncated)) = (match next {
                Ok(value) => value,
                Err(error) => {
                    fail_all(&client, format!("dsh-host stdout failed: {error}")).await;
                    return;
                }
            }) else {
                fail_all(&client, "dsh-host exited".to_string()).await;
                return;
            };
            if truncated {
                fail_all(
                    &client,
                    "dsh-host emitted an oversized protocol frame".to_string(),
                )
                .await;
                return;
            }
            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                tracing::warn!("dsh-host emitted non-JSON stdout");
                continue;
            };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Some(sender) = client.pending.lock().await.remove(&id) {
                    let result = protocol::response_result(&message)
                        .unwrap_or_else(|| Err("invalid dsh-host response".to_string()));
                    let _ = sender.send(result);
                }
                continue;
            }
            if let Some(route) = protocol::event_route(&message) {
                if let Some(sender) = client.routes.lock().await.get(&route) {
                    let _ = sender.send(message);
                }
            }
        }
    });
}

fn spawn_stderr_reader(mut reader: BufReader<tokio::process::ChildStderr>) {
    tokio::spawn(async move {
        while let Ok(Some((line, _))) = read_capped_line(&mut reader, 16 * 1024).await {
            let line = line.trim();
            if !line.is_empty() {
                tracing::info!(target: "dsh_host", "{}", crate::agent_external::truncate_for_log(line));
            }
        }
    });
}

async fn fail_all(client: &DshHostClient, message: String) {
    client.closed.store(true, Ordering::Release);
    for (_, sender) in client.pending.lock().await.drain() {
        let _ = sender.send(Err(message.clone()));
    }
    client.routes.lock().await.clear();
}

fn resolve_host_command() -> Result<(Command, PathBuf), String> {
    if !crate::dsh::status().installed {
        return Err("DeepSeek Harness runtime is not installed".to_string());
    }

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source_root = root.join("dsh-flowix-host");
    if let Some(configured) = std::env::var_os("FLOWIX_DSH_HOST_PATH").map(PathBuf::from) {
        return command_for_host_path_with_root(configured, Some(source_root.clone()));
    }
    let dev_script = root.join(".build/flowix-dsh-host/dsh-host.cjs");
    if cfg!(debug_assertions) {
        // In debug builds the dev bundle is the source of truth. Refuse to
        // fall through to a (possibly stale, possibly broken on Windows)
        // bundled sidecar so the failure is loud and points at the rebuild
        // command instead of silently spawning a host that crashes.
        if dev_script.is_file() {
            return command_for_host_path_with_root(dev_script, Some(source_root.clone()));
        }
        return Err(format!(
            "dsh-host dev bundle missing at {}; run `npm run dsh:build:dev`",
            dev_script.display(),
        ));
    }
    // Production clients use only the independently downloaded, versioned DSH
    // runtime. The Flowix application intentionally does not ship a DSH host;
    // selecting DSH in the UI must be what causes this installation to exist.
    if let Some(managed) = crate::dsh::managed_host_path() {
        return command_for_host_path(managed);
    }
    Err("DeepSeek Harness runtime is not installed".to_string())
}

/// Resolve the Flowix CLI that the independently installed DSH memory plugin
/// should invoke. The DSH host lives under the user data directory, while the
/// CLI remains the one executable shipped by Flowix.app.
fn bundled_flowix_cli_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let parent = executable.parent()?;
    let packaged = parent.join(if cfg!(windows) {
        "flowix-cli.exe"
    } else {
        "flowix-cli"
    });
    if packaged.is_file() {
        return Some(packaged);
    }

    if cfg!(debug_assertions) {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(if cfg!(windows) {
                "flowix-cli.exe"
            } else {
                "flowix-cli"
            });
        if development.is_file() {
            return Some(development);
        }
    }
    None
}

fn command_for_host_path(path: PathBuf) -> Result<(Command, PathBuf), String> {
    command_for_host_path_with_root(path, None)
}

fn command_for_host_path_with_root(
    path: PathBuf,
    source_root: Option<PathBuf>,
) -> Result<(Command, PathBuf), String> {
    let canonical = dunce::canonicalize(&path)
        .map_err(|error| format!("invalid dsh-host path {}: {error}", path.display()))?;
    let is_node_script = matches!(
        canonical.extension().and_then(|value| value.to_str()),
        Some("mjs" | "cjs" | "js")
    );
    let host_root = if is_node_script {
        source_root.or_else(|| {
            canonical
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
        })
    } else {
        canonical.parent().map(Path::to_path_buf)
    }
    .ok_or("dsh-host path has no parent")?;
    if is_node_script {
        let mut command = Command::new("node");
        command.arg(canonical);
        Ok((command, host_root))
    } else {
        Ok((Command::new(canonical), host_root))
    }
}

#[allow(dead_code)]
fn packaged_runtime_candidate() -> Option<PathBuf> {
    // Development builds use the freshly-built dsh-host bundle, which spawns
    // the runtime out of .build/flowix-dsh-host/ via devPackagedRuntimeBinary.
    // Honoring a packaged sidecar here would shadow that dev path and make
    // rebuilds look ineffective.
    if cfg!(debug_assertions) {
        return None;
    }
    let parent = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };
    // Prefer the tauri-triple suffix that matches the host triple; fall back
    // to the bare `dsh-runtime` name for installs that still ship a runtime
    // sidecar. Production builds no longer ship dsh-runtime (see
    // scripts/build-sidecars.mjs); this lookup is kept for diagnostic use only.
    let triple_suffix = rust_target_triple().to_string();
    let triple = parent.join(format!("dsh-runtime-{triple_suffix}{exe_suffix}"));
    if triple.is_file() {
        return Some(triple);
    }
    let bare = parent.join(format!("dsh-runtime{exe_suffix}"));
    bare.is_file().then_some(bare)
}

fn allowed_parent_environment() -> HashMap<String, String> {
    const KEYS: &[&str] = &[
        "PATH",
        "Path",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "HOME",
        "USERPROFILE",
        // Node 24's fetch only enables proxy support when this switch is set.
        // Preserve both casing variants because shells and GUI launchers do
        // not agree on the spelling used for proxy variables.
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
    let mut environment = KEYS
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| ((*key).to_string(), value))
        })
        .collect::<HashMap<_, _>>();

    // A macOS app launched from Finder commonly has no proxy variables in
    // its environment even though the system proxy is enabled. Python and
    // browsers discover that setting through the OS, while Node's fetch does
    // not. Fill only missing values so an explicitly configured environment
    // remains authoritative.
    if cfg!(target_os = "macos") {
        if let Some(proxy) = macos_https_proxy() {
            environment
                .entry("HTTPS_PROXY".to_string())
                .or_insert_with(|| proxy.clone());
            environment
                .entry("HTTP_PROXY".to_string())
                .or_insert_with(|| proxy.clone());
            environment.entry("ALL_PROXY".to_string()).or_insert(proxy);
        }
    }
    if environment.keys().any(|key| {
        matches!(
            key.as_str(),
            "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "http_proxy" | "https_proxy" | "all_proxy"
        )
    }) {
        environment
            .entry("NODE_USE_ENV_PROXY".to_string())
            .or_insert_with(|| "1".to_string());
    }
    environment
}

#[cfg(target_os = "macos")]
fn macos_https_proxy() -> Option<String> {
    let output = StdCommand::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let values = stdout
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim(), value.trim()))
        })
        .collect::<HashMap<_, _>>();
    if values.get("HTTPSEnable") != Some(&"1") {
        return None;
    }
    let host = values.get("HTTPSProxy")?.trim();
    let port = values.get("HTTPSPort")?.trim();
    if host.is_empty() || port.is_empty() {
        return None;
    }
    Some(format!("http://{host}:{port}"))
}

#[cfg(not(target_os = "macos"))]
fn macos_https_proxy() -> Option<String> {
    None
}

/// Locate the build identity shared by the dsh-host and dsh-runtime sidecars.
/// `None` means the env var simply will not be set; the host still validates
/// that `initialize` returns a non-empty buildId but does not enforce equality.
fn sidecar_build_id() -> Option<String> {
    // A downloaded DSH package owns its host/runtime build identity. Do not
    // inject a repository build id when a local release bundle is testing the
    // independently installed runtime.
    if crate::dsh::managed_host_path().is_some() {
        return None;
    }
    // Production builds install the file under the same directory as flowix-cli.
    // Walk up from `current_exe` until the file is found, mirroring how tauri
    // bundles keep .build next to the bundled resources.
    let start = std::env::current_exe().ok()?;
    let mut directory = Some(start.as_path());
    while let Some(dir) = directory {
        let candidate = dir
            .join(".build")
            .join("dsh-flowix-host")
            .join("dsh-build-id.txt");
        if candidate.is_file() {
            let raw = std::fs::read_to_string(&candidate).ok()?;
            let trimmed = raw.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
        directory = dir.parent();
    }
    None
}

/// The rustc target triple the desktop binary was compiled for. Used to pick
/// the matching `dsh-runtime-<triple>` sidecar from the same directory as
/// flowix.exe / Flowix.app. The result is computed at runtime because we do
/// not have a build script; the table is small enough that the lookup is
/// cheaper than the I/O it gates.
fn rust_target_triple() -> &'static str {
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    match (os, arch) {
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("windows", _) => "x86_64-pc-windows-msvc",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        _ => "unknown-unknown-unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::sync_credential_file;
    use std::collections::BTreeMap;

    #[test]
    fn sync_credential_file_merges_provider_references() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".credentials.yaml");
        sync_credential_file(&path, "FLOWIX_DSH_OPENAI_API_KEY", "secret-a").unwrap();
        sync_credential_file(&path, "FLOWIX_DSH_MINIMAX_API_KEY", "secret-b").unwrap();

        let values: BTreeMap<String, String> =
            serde_yaml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            values.get("FLOWIX_DSH_OPENAI_API_KEY"),
            Some(&"secret-a".to_string())
        );
        assert_eq!(
            values.get("FLOWIX_DSH_MINIMAX_API_KEY"),
            Some(&"secret-b".to_string())
        );
    }

    #[test]
    fn sync_credential_file_preserves_existing_entries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".credentials.yaml");
        std::fs::write(&path, "EXTERNAL_API_KEY: external-secret\n").unwrap();

        sync_credential_file(&path, "FLOWIX_DSH_OPENAI_API_KEY", "flowix-secret").unwrap();

        let values: BTreeMap<String, String> =
            serde_yaml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            values.get("EXTERNAL_API_KEY"),
            Some(&"external-secret".to_string())
        );
        assert_eq!(
            values.get("FLOWIX_DSH_OPENAI_API_KEY"),
            Some(&"flowix-secret".to_string())
        );
    }

    #[test]
    fn sync_credential_file_rejects_invalid_documents_and_references() {
        let temp = tempfile::tempdir().unwrap();
        let invalid_path = temp.path().join("invalid.yaml");
        std::fs::write(&invalid_path, "not: [valid").unwrap();
        assert!(sync_credential_file(&invalid_path, "FLOWIX_DSH_API_KEY", "secret").is_err());

        let valid_path = temp.path().join("valid.yaml");
        assert!(sync_credential_file(&valid_path, "not-a-reference", "secret").is_err());
        assert!(!valid_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn sync_credential_file_secures_document_and_lock() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".credentials.yaml");
        sync_credential_file(&path, "FLOWIX_DSH_API_KEY", "secret").unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let lock = path.with_extension("yaml.flowix-lock");
        assert_eq!(
            std::fs::metadata(lock).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
