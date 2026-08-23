//! DeepSeek Harness 全链路集成测试。
//!
//! 覆盖完整链路:
//!   React payload (JSON wire) → Tauri IPC 形状 (AgentUserMessage 反序列化)
//!   → Rust DeepSeekHarnessManager::chat_stream → dsh-host 子进程
//!   → mock SSE Provider → SQLite agent_external_events → 历史投影
//!   (get_external_event_messages_page / materialize_external_messages)。
//!
//! 这是唯一一条把 manager / host / runtime / provider / 持久化 / 投影全部串
//! 起来的测试 —— JS 侧的 `host-e2e` 与 `sidecar-e2e` 各自只覆盖 host 进程
//! 内部, 从未与 Rust manager 及 SQLite 落库闭环。
//!
//! 必须自带 harness (`harness = false`): `chat_stream` 收具体的
//! `&tauri::AppHandle` (`AppHandle<Wry>`), 而 macOS 上 tao 事件循环只能建在
//! 主线程 —— 标准测试 harness 的用例跑在 worker 线程, `Builder::any_thread()`
//! 在 macOS 也不暴露, 因此本测试在 `main()` 里持有主线程并手工驱动断言。
//!
//! 运行前置:
//!   * `npm --prefix dsh-flowix-host run build` 已产出
//!     `.build/flowix-dsh-host/dsh-host.cjs`
//!     (缺失时本测试直接 fail 并提示, 不静默跳过 —— 见 `require_host`).
//!   * dsh-host 的 vendored 开发 runtime 已安装
//!     (`vendor/deepseek-harness/node_modules`), host 会在没有
//!     `FLOWIX_DSH_RUNTIME_PATH` 时回落到 tsx + vendored bin.ts。
//!   * PATH 里有 node (host 是 .cjs 脚本, 由 `command_for_host_path` 以
//!     `node <script>` 启动)。
//!
//! 运行: `cargo test -p flowix-desktop --test deepseek_harness_e2e`

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Listener;

use flowix_desktop::agent_external::deepseek_harness::{DeepSeekHarnessManager, AGENT_TYPE};
use flowix_desktop::agent_session::ThreadManager;
use flowix_desktop::agent_wire::AgentUserMessage;
use flowix_desktop::config::UserConfigStore;

fn main() {
    // 1. dsh-host 产物必须在位 —— 缺失时给出可操作的提示而不是panic堆栈。
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let host_script = repo_root.join(".build/flowix-dsh-host/dsh-host.cjs");
    require_host(&host_script);
    // Runtime 用打包的 sidecar (与 sidecar-e2e 同路径, 等价于生产布局)。
    // Rust 侧 DshHostClient::spawn 会 env_clear, FLOWIX_DSH_RUNTIME_PATH 只能
    // 经 packaged_runtime_candidate() 传入 —— 它在测试 exe 同目录找
    // `dsh-host`, 因此把 sidecar 复制过去。
    let sidecar_runtime = stage_packaged_runtime(&repo_root);

    // 2. mock provider 先起在一个独立线程 (tokio runtime), 端口由内核分配。
    let provider = MockProvider::start();

    // 3. 共享夹具全部落在 tempdir, 不触碰真实 ~/.flowix。
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace dir");

    // ThreadManager 的 async API 以 `self: &Arc<Self>` 暴露 (内部把同步
    // rusqlite 工作丢进阻塞线程池), 因此这里必须先 Arc 再用。
    let thread_manager = Arc::new(ThreadManager::new_in_memory().expect("in-memory ThreadManager"));
    let user_config = Arc::new(UserConfigStore::new(temp.path().to_path_buf()));
    // set_ai_config 会把 key 挪进 secret store, get_ai_config 再 hydrate 回来 ——
    // 与生产路径一致, 因此走 setter 而不是直接改内存。
    user_config
        .set_ai_config(
            serde_json::from_value(json!({
                "model": {
                    "provider": "DeepSeek",
                    "model": "deepseek-e2e-model",
                    "apiUrl": provider.base_url(),
                    "apiKeys": { "DeepSeek": "e2e-secret" },
                }
            }))
            .expect("valid AiConfigFile"),
        )
        .expect("persist ai config");

    // 4. host 解析顺序: FLOWIX_DSH_HOST_PATH 优先于 exe 同目录探测 —— 用它把
    //    测试钉在仓内已构建的 dsh-host.cjs 上。子进程继承本进程环境, 所以在
    //    spawn manager 之前设置即可。
    std::env::set_var("FLOWIX_DSH_HOST_PATH", &host_script);
    std::env::set_var("DSH_API_KEY", "e2e-secret");
    // sidecar 落到 exe 同目录后, host 的 packaged_runtime_candidate() 会命中
    // 它并设置 FLOWIX_DSH_RUNTIME_PATH (runtimeLaunch 走自引用 + MODE=1,
    // 与生产/sidecar-e2e 完全一致)。
    let _ = &sidecar_runtime;

    // 5. 真实 Wry AppHandle (主线程) + agent-chunk 监听, 验证 manager 通过
    //    Tauri 事件系统真实 emit 的 payload (前端消费的同一条通道)。
    //    注意: 必须用默认 Builder (Wry), 不能用 mock_builder —— chat_stream
    //    的签名是具体的 &tauri::AppHandle (= AppHandle<Wry>), MockRuntime
    //    类型不匹配; mock_context 只提供空配置, runtime 本体保持真实。
    let app = tauri::Builder::default()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build tauri app");
    let app_handle = app.handle().clone();
    let emitted = Arc::new(Mutex::new(Vec::<Value>::new()));
    {
        let emitted = emitted.clone();
        app.listen("agent-chunk", move |event| {
            let payload = serde_json::from_str::<Value>(&event.payload())
                .expect("agent-chunk payload is JSON");
            emitted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(payload);
        });
    }

    let dsh_sessions = user_config.dsh_sessions_dir();
    let manager = Arc::new(DeepSeekHarnessManager::new(
        thread_manager.clone(),
        user_config,
        dsh_sessions,
    ));

    // 6. React → IPC 边界: 前端发出的就是这团 camelCase JSON。用反序列化还原,
    //    而不是手工构造结构体 —— 契约 (字段名/嵌套) 断在这一步。
    let message: AgentUserMessage = serde_json::from_value(json!({
        "content": "reply briefly",
        "runId": "run-e2e-1",
        "agentType": AGENT_TYPE,
        "runtimeConfig": {
            "deepseekHarness": {
                "cwd": workspace.to_string_lossy(),
                "permissionMode": "read-only",
            }
        }
    }))
    .expect("frontend payload deserializes into AgentUserMessage");

    // 7. 驱动 chat_stream。它在内部 spawn, 立即返回 —— 与 IPC 命令行为一致;
    //    用 SQLite 落库的 StreamEnd 作为完成信号轮询等待。
    tauri::async_runtime::block_on(async {
        manager
            .chat_stream("thread-e2e-1", message, &app_handle)
            .await
            .expect("chat_stream accepts the run");

        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let ended = thread_manager
                .list_agent_external_events_by_thread("thread-e2e-1", None, 1000)
                .await
                .expect("list events")
                .iter()
                .any(|event| event.normalized_json.contains("\"kind\":\"stream_end\""));
            if ended {
                break;
            }
            if std::time::Instant::now() > deadline {
                dump_diagnostics(&thread_manager, &emitted).await;
                panic!("timed out waiting for the DSH run to persist stream_end");
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });

    // 8. 断言链路每一跳。
    tauri::async_runtime::block_on(async {
        assert_provider_turn(&provider, &thread_manager).await;
        assert_emitted_chunks(&emitted);
        assert_sqlite_history(&thread_manager).await;
        assert_history_projection(&thread_manager).await;
    });

    // 9. 清理: 杀 host 子进程, 停 mock provider。
    tauri::async_runtime::block_on(manager.stop_all());
    provider.shutdown();

    println!("deepseek_harness_e2e: all assertions passed");
}

fn require_host(host_script: &Path) {
    if host_script.is_file() {
        return;
    }
    panic!(
        "dsh-host is not built: {} is missing; run `npm --prefix dsh-flowix-host run build` first",
        host_script.display()
    );
}

/// 把打包的 dsh-host sidecar 复制到测试 exe 同目录 (名为 `dsh-host`), 让
/// DshHostClient::spawn 的 packaged_runtime_candidate() 探测命中 —— Rust
/// 侧 env_clear 之后, 这是唯一把 runtime 交给 host 的通道。sidecar 缺失时
/// 返回 None: host 会回落到 vendored 开发 runtime, 测试仍可运行 (前提是
/// vendored 依赖完整)。
fn stage_packaged_runtime(repo_root: &Path) -> Option<PathBuf> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let triple = if cfg!(target_os = "macos") {
        format!("{}-apple-darwin", std::env::consts::ARCH)
    } else if cfg!(target_os = "linux") {
        format!("{}-unknown-linux-gnu", std::env::consts::ARCH)
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc".to_string()
    } else {
        return None;
    };
    let source = repo_root.join(format!(
        "app/flowix-desktop/binaries/dsh-host-{triple}{suffix}"
    ));
    if !source.is_file() {
        eprintln!(
            "note: packaged dsh-host sidecar not found at {}; falling back to the vendored dev runtime",
            source.display()
        );
        return None;
    }
    let target_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let target = target_dir.join(format!("dsh-host{suffix}"));
    std::fs::copy(&source, &target).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    Some(target)
}

async fn dump_diagnostics(thread_manager: &Arc<ThreadManager>, emitted: &Arc<Mutex<Vec<Value>>>) {
    let events = thread_manager
        .list_agent_external_events_by_thread("thread-e2e-1", None, 1000)
        .await
        .unwrap_or_default();
    eprintln!("--- persisted events: {} ---", events.len());
    for event in &events {
        eprintln!("[{}] {}", event.id, event.normalized_json);
    }
    let chunks = emitted
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    eprintln!("--- emitted agent-chunk: {} ---", chunks.len());
    for chunk in chunks.iter() {
        eprintln!("{}", chunk);
    }
}

/// Provider 一跳: dsh-host → vendored runtime → mock SSE。断言请求形状
/// (Bearer key、stream:true、模型名), 证明 Rust manager 解析的连接配置
/// 穿透了 host 与 runtime 两层环境边界。
async fn assert_provider_turn(provider: &MockProvider, thread_manager: &Arc<ThreadManager>) {
    let requests = provider.requests();
    if requests.len() != 1 {
        // provider 未命中 —— 打出落库事件, 看 run 是失败还是走了别的出口。
        let events = thread_manager
            .list_agent_external_events_by_thread("thread-e2e-1", None, 1000)
            .await
            .unwrap_or_default();
        for event in &events {
            eprintln!("[persisted {}] {}", event.id, event.normalized_json);
        }
    }
    assert_eq!(
        requests.len(),
        1,
        "expected exactly one provider request, got {requests:?}"
    );
    let request = &requests[0];
    assert_eq!(request.url, "/chat/completions");
    assert_eq!(request.authorization, Some("Bearer e2e-secret".to_string()));
    assert_eq!(request.model, "deepseek-e2e-model");
    assert!(request.stream, "runtime must request SSE streaming");
    assert!(
        request.body.contains("reply briefly"),
        "prompt must reach the provider; body was {}",
        request.body
    );
}

/// IPC emit 一跳: manager 通过 Tauri 事件系统推给前端的 chunk 序列。
fn assert_emitted_chunks(emitted: &Arc<Mutex<Vec<Value>>>) {
    let chunks = emitted
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let kinds: Vec<&str> = chunks
        .iter()
        .filter_map(|chunk| chunk.get("kind").and_then(Value::as_str))
        .collect();
    assert_eq!(
        kinds.first(),
        Some(&"user_message"),
        "user_message must lead the live stream; got {kinds:?}"
    );
    assert!(
        kinds.contains(&"stream_start"),
        "stream_start missing from {kinds:?}"
    );
    assert!(
        kinds.contains(&"text"),
        "assistant text missing from {kinds:?}"
    );
    assert_eq!(
        kinds.last(),
        Some(&"stream_end"),
        "stream_end must close the live stream; got {kinds:?}"
    );
    for chunk in chunks.iter() {
        assert_eq!(
            chunk.get("agent_type").and_then(Value::as_str),
            Some(AGENT_TYPE)
        );
        assert_eq!(
            chunk.get("run_id").and_then(Value::as_str),
            Some("run-e2e-1"),
            "every chunk must carry the frontend run id"
        );
    }
}

/// SQLite 一跳: 完整历史协议要求首事件是 user_message (前端 replay 的
/// legacy 判定依赖它), 且 canonical id / run id 形状与共享身份层一致。
async fn assert_sqlite_history(thread_manager: &Arc<ThreadManager>) {
    let events = thread_manager
        .list_agent_external_events_by_thread("thread-e2e-1", None, 1000)
        .await
        .expect("list persisted events");
    assert!(!events.is_empty(), "no events persisted");
    assert_eq!(events[0].runtime, AGENT_TYPE);
    assert_eq!(events[0].thread_id, "thread-e2e-1");

    let first: Value =
        serde_json::from_str(&events[0].normalized_json).expect("first event is JSON");
    assert_eq!(first["kind"], "user_message");
    assert_eq!(first["run_id"], "run-e2e-1");
    assert_eq!(
        first["message_id"],
        format!("msg:{AGENT_TYPE}:run-e2e-1:user:user-run-e2e-1"),
        "canonical user id must follow the shared identity scheme"
    );

    let has_text = events.iter().any(|event| {
        let Ok(value) = serde_json::from_str::<Value>(&event.normalized_json) else {
            return false;
        };
        value["kind"] == "text" && value["text"] == "hello from mock provider"
    });
    assert!(has_text, "assistant text missing from persisted log");
}

/// 投影一跳: 前端历史加载走的同一条后端路径 —— 消息物化 + DSH segment /
/// legacy thinking 归一化。用户回合必须是完整一轮 (user → assistant)。
async fn assert_history_projection(thread_manager: &Arc<ThreadManager>) {
    let page = thread_manager
        .get_external_event_messages_page(AGENT_TYPE, "thread-e2e-1", None, 50)
        .await
        .expect("project history page")
        .expect("event history exists");
    assert!(!page.messages.is_empty(), "projection is empty");

    let roles: Vec<(&str, &str)> = page
        .messages
        .iter()
        .map(|message| (message.role.as_str(), message.id.as_str()))
        .collect();
    let user_index = roles
        .iter()
        .position(|(role, _)| *role == "user")
        .expect("projected history contains a user turn");
    let assistant_index = roles
        .iter()
        .position(|(role, _)| *role == "assistant")
        .expect("projected history contains an assistant turn");
    assert!(
        user_index < assistant_index,
        "user turn must precede assistant turn; got {roles:?}"
    );
    assert_eq!(
        page.messages[user_index].content, "reply briefly",
        "user turn text mismatch"
    );
    assert_eq!(
        page.messages[assistant_index].content, "hello from mock provider",
        "assistant turn must be materialized from the persisted text events"
    );
}

// ---------------------------------------------------------------------
// mock provider: 最小 SSE chat/completions 服务器
// ---------------------------------------------------------------------

struct MockProvider {
    base_url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    handle: std::thread::JoinHandle<()>,
}

#[derive(Debug, Clone)]
struct RecordedRequest {
    url: String,
    authorization: Option<String>,
    model: String,
    stream: bool,
    body: String,
}

impl MockProvider {
    /// 在独立线程的 tokio runtime 上起服务器。用线程而非直接共享 runtime,
    /// 是因为宿主 main 的 block_on 用的是 tauri::async_runtime, 两个 runtime
    /// 不能嵌套, 各自持有即可。
    fn start() -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<String>();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        let requests_for_thread = requests.clone();
        let handle = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("provider runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bind mock provider");
                let address = listener.local_addr().expect("mock provider address");
                ready_tx
                    .send(format!("http://{address}"))
                    .expect("report provider base url");
                loop {
                    let accepted = tokio::select! {
                        accepted = listener.accept() => accepted,
                        _ = shutdown_rx.changed() => break,
                    };
                    let Ok((stream, _address)) = accepted else {
                        continue;
                    };
                    let requests = requests_for_thread.clone();
                    tokio::spawn(async move {
                        serve_connection(stream, requests).await;
                    });
                }
            });
        });
        let base_url = ready_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("mock provider to start");
        Self {
            base_url,
            requests,
            shutdown_tx,
            handle,
        }
    }

    fn base_url(&self) -> String {
        self.base_url.clone()
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.handle.join();
    }
}

async fn serve_connection(
    mut stream: tokio::net::TcpStream,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    // 读到请求头+body (以空行分隔); body 长度由 Content-Length 决定。
    let (head_end, content_length) = loop {
        let read = stream.read(&mut chunk).await.unwrap_or(0);
        if read == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = find_subsequence(&buffer, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..position]).to_string();
            let content_length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.trim()
                        .eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            break (position, content_length);
        }
    };
    while buffer.len() < head_end + 4 + content_length {
        let read = stream.read(&mut chunk).await.unwrap_or(0);
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }

    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let request_line = head.lines().next().unwrap_or_default().to_string();
    let url = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    let authorization = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("authorization")
            .then(|| value.trim().to_string())
    });
    let body = String::from_utf8_lossy(&buffer[head_end + 4..]).to_string();
    let parsed: Option<Value> = serde_json::from_str(&body).ok();
    let (model, stream_flag) = parsed
        .as_ref()
        .map(|value| {
            (
                value["model"].as_str().unwrap_or_default().to_string(),
                value["stream"].as_bool().unwrap_or(false),
            )
        })
        .unwrap_or_default();
    requests
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(RecordedRequest {
            url,
            authorization,
            model,
            stream: stream_flag,
            body,
        });

    let events = [
        json!({ "choices": [{ "delta": { "role": "assistant", "content": null, "reasoning_content": "" } }] }),
        json!({ "choices": [{ "delta": { "content": "hello from mock provider" } }] }),
        json!({ "choices": [{ "delta": { "content": "" }, "finish_reason": "stop" }], "usage": { "prompt_tokens": 12, "completion_tokens": 4 } }),
    ];
    let mut response = String::from(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
    );
    for event in &events {
        response.push_str(&format!("data: {event}\n\n"));
    }
    response.push_str("data: [DONE]\n\n");
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
