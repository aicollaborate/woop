# dsh-appserver 设计

## 设计目标

提供与 Codex app-server 相似的 Thread/Turn/Item 控制面，同时保持 DSH、协议和 transport 三层解耦。

```text
stdio / HTTP / SSE
        ↓
DshAppServer（握手、队列、错误边界）
        ↓
资源方法目录（Thread / Turn / Command / Model / Credential / Runtime / Session）
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
- 只暴露一套 canonical 方法名，Flowix 自有扩展统一放在 `flowix/*` 下。
- 请求经过有界 per-thread 队列：同一 Thread 串行，不同 Thread 并行；stdio framing 额外保持输入顺序。
- `NativeDshAdapter` 只把 Flowix 的缓存图片转换为编码上传项；DSH `ctx.attachments` 在事件落盘前完成 admission。事件永远保存 durable attachment reference，不保存本地路径、URL 或 base64。
- command 本身是 log-only operation，不把命令文本伪装成普通 prompt。命令 handler 的 DSH-owned effect 通过 `thread/command` 响应返回：`/compact` 是 `turn: none`，带 prompt 的 `/plan` 是 `turn: steer`，`/goal` 的创建/编辑/恢复由 `goal-round-driver` 产生 `turn: goal-round`。桌面 transport 只消费 effect 并观察已经发生的 DSH turn，不再按命令名猜测或使用发现超时。`command/run` 与 `command/done` 通过 `commandId` 聚合；前端的 pending/success/error 只是实时 bridge，完成后重新投影权威 event log。

## DSH 映射

| App Server | DSH |
|---|---|
| `thread/start` | `ctx.agents.create({ sessionId })` |
| `thread/resume` | `ctx.agents.resume({ resumeSessionId })` |
| `thread/fork` | 使用稳定事件前缀作为 Agent Factory seed |
| `thread/read` | live Session 或 `sessionPersistence.open(id, 'read')` |
| `thread/list` | live catalog；冷启动时枚举 persistence |
| `turn/start` | `agent.followup()`，由 DSH inbox 排队 |
| `turn/steer` | `agent.steer()`，注入当前 Turn 的 next-step inbox；不创建第二个 Flowix run |
| `turn/interrupt` | `agent.cancel({ kind: 'user' }, { keepInbox: true })` |
| `thread/command` | `ctx.commands.execute(agent, line, submittedAttachments, signal)`；命令拥有者决定参数和附件语义，并返回 transport 可消费的 DSH effect |
| `thread/skills` | 当前 Agent scope 的 DSH Skill registry |
| `thread/archive` | DSH workspace-controller archive；保留 event log，不等同于 runtime close 或删除 |
| `model/catalog` | 已配置 provider route 的 catalog |
| `model/discover` | `ctx.llm.discoverModels()` |
| `model/config/*` | `ctx.settings` 的 `llm-pi-ai` namespace |
| `credential/*` | `ctx.credentials` |

## 协议边界

- 每个连接必须先 `initialize`；重复初始化返回 `-32003`。
- 未初始化请求返回 `-32002`。
- 无效请求、参数、未知方法分别返回 `-32600`、`-32602`、`-32601`。
- 队列满时返回 `-32001`，客户端应退避重试。
- Turn 和 Item 进度通过通知流输出，持久历史以 DSH event log 为事实源。
- steer 的文本和附件先通过 DSH inbox/attachment admission，再追加 `user/message`，因此会在同一 Turn 内显示为真实 user message；Flowix 不伪造历史消息。
- `initialize`、重复初始化和通知 opt-out 按 transport connection 隔离。
- durable event projector 同时服务 `thread/read`、`session/history`、重启恢复和 SSE 补发，Turn/Item ID 在进程重启后保持稳定。`thread/read` 与 `session/history` 都是完整 transcript 语义：compact 只改写 DSH 的模型 surface，不删除 UI 历史；checkpoint 和 standalone command 以 timeline item/turn 投影。历史分页按完整 Turn 边界切分，首个 Turn 前的 standalone command 会并入最老页。
- command/run 与 command/done 可能跨分页边界；projector 先对完整 snapshot 按 commandId 聚合，再投影当前页，避免 pending 被误判为完成或反向复活。
- live snapshot 会复制事件数组；冷历史优先使用 persistence read handle，并在读完后关闭 handle。
- Agent runtime 是唯一写句柄 owner。adapter 先复用 live runtime，再以 session 为粒度 single-flight 恢复；`ctx.agents.resume()` 不能与已登记的 runtime 并发执行。

## 命令与对话生命周期

- `/compact` 只在 Agent idle 时由 DSH compaction seam 执行；运行中的轮次返回 `busy`，命令不排队、不创建 Turn。成功后通过 `compaction/*` surface replacement 改写模型上下文；`thread/read`/`session/history` 仍保留旧 transcript，并追加一个 compact checkpoint。
- `/plan <prompt>` 由 DSH `agent.steer()` 投递到当前 Turn 的 next-step inbox；`/plan` 与 `/plan off` 只改变模式状态，不伪造普通 prompt。
- `/goal` 先持久化 goal 状态；后续 Goal Round 由 DSH driver 在 Agent idle 时用 `agent.followup()` 排队。命令本身不转换当前正在运行的普通 Turn。
- Goal Round 的桌面投影使用独立的 session-level watcher：每个实际 `turn/start` 注册一个独立 Flowix run，`turn/end` 后立即释放运行锁；轮次之间通过 `goal/changed` 继续等待，因此普通用户输入可以插入，后续 round 仍由 DSH driver 原生调度。`goal/change` 的完成、阻塞、暂停和清除会结束 watcher，不使用轮询或固定发现超时。
- command response、inbox admission、turn completion 是三个独立状态；`command/done` 不代表后续模型 Turn 已完成。

## Fork

Fork 只接受事件序列中的稳定消息边界。子 Thread 使用新的 Session ID，并在 metadata 中保存 `parentSession` 和 seed 长度。

## 安全

- 模型配置读取必须使用 `redactSecrets: true`。
- Credential reference 只允许环境变量名称格式。
- HTTP 默认只绑定回环地址；远程暴露由宿主负责认证、TLS 和访问控制。
- 外部请求只传标量、JSON 数据和 ID，不允许注入 DSH 对象。
- 附件 admission 是协议边界：宿主重新授权缓存路径并读取字节，app-server 再调用 DSH attachment service；任何未 admission 的本地路径都不会进入 Session event。

## 前端 slash 所有权

slash descriptor 在 Flowix composer 中标注 `owner`、`interaction` 和 `execution`。DSH 的 `compact`/`goal`/`plan`/`export` 走 command registry，`skill` 先从当前 DSH Agent scope 下钻，`model`/`permission` 是 Flowix host action。不同 Agent 不共享 descriptor，即使命令名相同也必须重新声明和实现。

## 验收

- 协议：握手、重复初始化、错误码、Thread/Turn/Fork/分页。
- 管理：Model 和 Credential 的读取、修改、删除与 revision 冲突。
- Transport：RPC、无效 JSON、健康检查和 Origin 防护。
- Runtime：使用 Flowix 本地 DSH 验证真实 Agent、Session、Fork、Cancel、Persistence。
