# dsh-app-server 设计

## 设计目标

提供与 Codex app-server 相似的 Thread/Turn/Item 控制面，同时保持 DSH、协议和 transport 三层解耦。

```text
stdio / HTTP / SSE
        ↓
DshAppServer（握手、队列、错误边界）
        ↓
资源方法目录（Thread / Turn / Model / Credential / Runtime / Session）
        ↓
NativeDshAdapter
        ↓
ctx.agents / ctx.sessions / sessionPersistence / ctx.llm / ctx.settings / ctx.credentials
```

## 组织原则

- 一个生产 dispatcher：测试不得维护另一套协议实现。
- 方法按资源注册：增加接口时修改对应 `methods/<resource>.js`。
- Adapter 不解析 JSON-RPC；handler 不访问 Cordis context。
- Transport 只负责 framing、连接和健康检查。
- 旧协议名称只作为 handler alias，不进入领域对象。
- 请求经过有界 per-thread 队列：同一 Thread 串行，不同 Thread 并行；stdio framing 额外保持输入顺序。

## DSH 映射

| App Server | DSH |
|---|---|
| `thread/start` | `ctx.agents.create({ sessionId })` |
| `thread/resume` | `ctx.agents.resume({ resumeSessionId })` |
| `thread/fork` | 使用稳定事件前缀作为 Agent Factory seed |
| `thread/read` | live Session 或 `sessionPersistence.inspect()` |
| `thread/list` | live catalog；冷启动时枚举 persistence |
| `turn/start` | `agent.followup()`，由 DSH inbox 排队 |
| `turn/interrupt` | `agent.cancel({ kind: 'user' }, { keepInbox: true })` |
| `model/list` | `ctx.llm.discoverModels()` |
| `model/config/*` | `ctx.settings` 的 `llm-pi-ai` namespace |
| `credential/*` | `ctx.credentials` |

## 协议边界

- 每个连接必须先 `initialize`；重复初始化返回 `-32003`。
- 未初始化请求返回 `-32002`。
- 无效请求、参数、未知方法分别返回 `-32600`、`-32602`、`-32601`。
- 队列满时返回 `-32001`，客户端应退避重试。
- Turn 和 Item 进度通过通知流输出，持久历史以 DSH event log 为事实源。
- `initialize`、重复初始化和通知 opt-out 按 transport connection 隔离。
- durable event projector 同时服务 `thread/read`、重启恢复和 SSE 补发，Turn/Item ID 在进程重启后保持稳定。

## Fork

Fork 只接受事件序列中的稳定消息边界。子 Thread 使用新的 Session ID，并在 metadata 中保存 `parentSession` 和 seed 长度。

## 安全

- 模型配置读取必须使用 `redactSecrets: true`。
- Credential reference 只允许环境变量名称格式。
- HTTP 默认只绑定回环地址；远程暴露由宿主负责认证、TLS 和访问控制。
- 外部请求只传标量、JSON 数据和 ID，不允许注入 DSH 对象。

## 验收

- 协议：握手、重复初始化、错误码、Thread/Turn/Fork/分页。
- 管理：Model 和 Credential 的读取、修改、删除与 revision 冲突。
- Transport：RPC、无效 JSON、健康检查和 Origin 防护。
- Runtime：使用 Flowix 本地 DSH 验证真实 Agent、Session、Fork、Cancel、Persistence。
