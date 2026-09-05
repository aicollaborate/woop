use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::agent_external::shared::{kill_child_tree, read_capped_line};

type Pending = oneshot::Sender<Result<Value, String>>;

/// A transport for the DSH App Server JSON-RPC/JSONL protocol.
///
/// It forwards dsh-appserver requests verbatim and routes server notifications
/// by their provider-owned thread id.
pub(crate) struct AppServerClient {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    routes: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

#[async_trait::async_trait]
impl super::transport::DshClient for AppServerClient {
    fn next_request_id(&self) -> u64 {
        self.next_request_id()
    }
    fn is_closed(&self) -> bool {
        self.is_closed()
    }
    async fn request(&self, value: Value) -> Result<Value, String> {
        self.request(value).await
    }
    async fn subscribe(&self, thread_id: &str, _run_id: &str) -> mpsc::UnboundedReceiver<Value> {
        self.subscribe(thread_id).await
    }
    async fn unsubscribe(&self, thread_id: &str, _run_id: &str) {
        self.unsubscribe(thread_id).await
    }
    async fn shutdown(&self) {
        self.shutdown().await
    }
}

impl AppServerClient {
    pub(crate) async fn spawn(
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Arc<Self>, String> {
        let mut process = Command::new(command);
        // DSH runs as a background stdio service and must not allocate a
        // visible console when Flowix starts it on Windows.
        crate::process_window::hide_command_window(&mut process);
        process
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = process
            .spawn()
            .map_err(|error| format!("start dsh-appserver: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or("dsh-appserver stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("dsh-appserver stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("dsh-appserver stderr unavailable")?;
        let client = Arc::new(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            routes: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });
        Self::spawn_reader(client.clone(), BufReader::new(stdout));
        Self::spawn_stderr_reader(BufReader::new(stderr));
        Ok(client)
    }

    pub(crate) fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }
    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(crate) async fn request(&self, value: Value) -> Result<Value, String> {
        if self.is_closed() {
            return Err("dsh-appserver is not running".into());
        }
        let id = value
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("App Server request has no numeric id")?;
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        tracing::info!(target: "dsh_appserver", request_id = id, method, "sending App Server request");
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let frame = format!("{value}\n");
        if let Err(error) = self.stdin.lock().await.write_all(frame.as_bytes()).await {
            self.pending.lock().await.remove(&id);
            return Err(format!("write dsh-appserver request: {error}"));
        }
        match tokio::time::timeout(std::time::Duration::from_secs(125), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("dsh-appserver response channel closed".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("dsh-appserver request timed out".into())
            }
        }
    }

    pub(crate) async fn subscribe(&self, thread_id: &str) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.routes.lock().await.insert(thread_id.to_string(), tx);
        rx
    }

    pub(crate) async fn unsubscribe(&self, thread_id: &str) {
        self.routes.lock().await.remove(thread_id);
    }

    pub(crate) async fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        let mut child = self.child.lock().await;
        kill_child_tree(&mut child, "dsh-appserver", "app-server").await;
    }

    fn spawn_reader(client: Arc<Self>, mut reader: BufReader<tokio::process::ChildStdout>) {
        tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                let bytes = match reader.read_line(&mut line).await {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        client
                            .fail_all(format!("dsh-appserver stdout failed: {error}"))
                            .await;
                        return;
                    }
                };
                if bytes == 0 {
                    client.fail_all("dsh-appserver exited".into()).await;
                    return;
                }
                let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    let failed = message.get("error").is_some();
                    tracing::info!(target: "dsh_appserver", request_id = id, failed, "received App Server response");
                    if let Some(sender) = client.pending.lock().await.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("App Server request failed")
                                .to_string())
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                } else {
                    let method = message
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let thread_id = message.pointer("/params/threadId").and_then(Value::as_str);
                    tracing::info!(target: "dsh_appserver", method, thread_id = thread_id.unwrap_or("<none>"), "received App Server notification");
                    if let Some(thread_id) = thread_id {
                        let routes = client.routes.lock().await;
                        if let Some(sender) = routes.get(thread_id) {
                            let _ = sender.send(message);
                        } else {
                            tracing::warn!(target: "dsh_appserver", method, thread_id, "no subscriber for App Server notification");
                        }
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
                    tracing::info!(target: "dsh_appserver", "{}", crate::agent_external::truncate_for_log(line));
                }
            }
        });
    }

    async fn fail_all(&self, message: String) {
        self.closed.store(true, Ordering::Release);
        for (_, sender) in self.pending.lock().await.drain() {
            let _ = sender.send(Err(message.clone()));
        }
        self.routes.lock().await.clear();
    }
}
