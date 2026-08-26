use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
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
        session_root: &Path,
        dsh_home: &Path,
        settings_path: &Path,
        credentials_path: &Path,
        plugin_settings_path: &Path,
    ) -> Result<Arc<Self>, String> {
        let (mut command, host_root) = resolve_host_command()?;
        if let Some(build_id) = development_host_build_id() {
            command.env("FLOWIX_DSH_BUILD_ID", build_id);
        }
        command
            .env_clear()
            .envs(allowed_parent_environment())
            .envs(crate::dsh::managed_child_environment(&host_root))
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

        // The host embeds a build identity so stale development output is
        // detected before requests are sent to the runtime.
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
                     rebuild via `npm run dsh:build:dev`"
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
            "session-history",
            "credentials-management",
            "model-settings-management",
        ] {
            if !capabilities
                .iter()
                .any(|value| value.as_str() == Some(required))
            {
                client.kill().await;
                return Err(format!(
                    "installed DeepSeek Harness runtime is incompatible: missing {required} capability; update or reinstall DSH from Flowix"
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
    let source_root = root.join("dsh-flowix-host");
    let dev_script = root.join(".build/flowix-dsh-host/dsh-host.cjs");
    if cfg!(debug_assertions) {
        // Exercise a locally built release bundle through the exact same
        // node-bundle contract as a managed production installation. The
        // bundle-private Node must launch the host so host and runtime share
        // one Node version/ABI and one immutable bundle root.
        if std::env::var_os("FLOWIX_DSH_BUNDLE_ROOT").is_some() {
            let managed = crate::dsh::development_bundle_launch_spec()
                .expect("FLOWIX_DSH_BUNDLE_ROOT was present")?;
            let mut command = Command::new(&managed.executable);
            command.args(&managed.args);
            return Ok((command, managed.root));
        }
        // Repository development owns its local host/runtime path. It must not
        // depend on the release-only managed installer (whose manifest may not
        // publish an artifact for the current platform yet).
        // In debug builds the dev bundle is the source of truth. Refuse to
        // fall through to an installed production bundle.
        if dev_script.is_file() {
            return command_for_host_path_with_root(dev_script, Some(source_root.clone()));
        }
        return Err(format!(
            "dsh-host dev bundle missing at {}; run `npm run dsh:build:dev`",
            dev_script.display(),
        ));
    }
    if !crate::dsh::status().installed {
        return Err("DeepSeek Harness runtime is not installed".to_string());
    }
    // Production clients use only the independently downloaded, versioned DSH
    // runtime. The Flowix application intentionally does not ship a DSH host;
    // selecting DSH in the UI must be what causes this installation to exist.
    if let Some(managed) = crate::dsh::managed_launch_spec() {
        let mut command = Command::new(&managed.executable);
        command.args(&managed.args);
        return Ok((command, managed.root));
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
        // Explicit development overrides for testing a separately published
        // DSH runtime bundle without changing release installation state.
        "FLOWIX_DSH_RUNTIME_PATH",
        "FLOWIX_DSH_RUNTIME_ARGS",
        "FLOWIX_DSH_RUNTIME_ROOT",
    ];
    let mut environment = KEYS
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| ((*key).to_string(), value))
        })
        .collect::<HashMap<_, _>>();

    // Bundle-root mode is intentionally a single-source launch contract.
    // Do not let stale low-level overrides replace only its runtime while the
    // host and profile still come from the selected bundle.
    if std::env::var_os("FLOWIX_DSH_BUNDLE_ROOT").is_some() {
        environment.remove("FLOWIX_DSH_RUNTIME_PATH");
        environment.remove("FLOWIX_DSH_RUNTIME_ARGS");
        environment.remove("FLOWIX_DSH_RUNTIME_ROOT");
    }

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

/// Locate the repository development host build identity.
fn development_host_build_id() -> Option<String> {
    // A downloaded DSH package owns its host/runtime build identity. Do not
    // inject a repository build id when a local release bundle is testing the
    // independently installed runtime.
    if crate::dsh::managed_host_path().is_some()
        || std::env::var_os("FLOWIX_DSH_BUNDLE_ROOT").is_some()
    {
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
