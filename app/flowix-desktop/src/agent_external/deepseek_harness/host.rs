use std::collections::HashMap;
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
        api_key: Option<&str>,
        session_root: &Path,
        dsh_home: &Path,
        settings_path: &Path,
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
            .env("FLOWIX_DSH_HOME", dsh_home)
            .env("FLOWIX_DSH_ROOT", &host_root)
            .env("DSH_SETTINGS_PATH", settings_path)
            .env("FLOWIX_DSH_PLUGIN_SETTINGS_PATH", plugin_settings_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
            command.env("DSH_API_KEY", api_key);
        }
        if let Some(runtime) = packaged_runtime_candidate() {
            command.env("FLOWIX_DSH_RUNTIME_PATH", runtime);
        }
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
        }        for required in ["model-catalog", "model-discovery", "plugin-catalog"] {
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
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source_root = root.join("app/flowix-dsh-host");
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
    if let Some(parent) = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
    {
        let candidate = parent.join(if cfg!(windows) {
            "dsh-host.exe"
        } else {
            "dsh-host"
        });
        if candidate.is_file() {
            return command_for_host_path(candidate);
        }
    }
    if dev_script.is_file() {
        return command_for_host_path_with_root(dev_script, Some(source_root));
    }
    Err("dsh-host is not built; run `npm --prefix app/flowix-dsh-host run build`".to_string())
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

fn packaged_runtime_candidate() -> Option<PathBuf> {
    // Development builds launch the vendored TypeScript runtime through the
    // freshly-built dsh-host source path. A stale sidecar left in Cargo's
    // target directory must not shadow that runtime, otherwise rebuilding the
    // host appears to have no effect during `tauri dev`.
    if cfg!(debug_assertions) {
        return None;
    }
    let parent = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let unified = parent.join(if cfg!(windows) {
        "dsh-host.exe"
    } else {
        "dsh-host"
    });
    if unified.is_file() {
        return Some(unified);
    }
    let legacy = parent.join(if cfg!(windows) {
        "dsh-runtime.exe"
    } else {
        "dsh-runtime"
    });
    legacy.is_file().then_some(legacy)
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
    // Production builds install the file under the same directory as flowix-cli.
    // Walk up from `current_exe` until the file is found, mirroring how tauri
    // bundles keep .build next to the bundled resources.
    let start = std::env::current_exe().ok()?;
    let mut directory = Some(start.as_path());
    while let Some(dir) = directory {
        let candidate = dir.join(".build").join("flowix-dsh-host").join("dsh-build-id.txt");
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