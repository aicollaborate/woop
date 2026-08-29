# dsh-appserver

## Approvals

The server is a channel adapter for DSH's native `ctx.approval` seam. It never writes
`approval/asked` or `approval/decided` itself. Owned agent requests are delivered as
server-initiated JSON-RPC requests and resolve to DSH's one-shot outcomes:

- `accept` → `allowed-once`
- `decline` → `rejected`
- `cancel` → `cancelled`

stdio clients answer with a normal JSON-RPC response using the server request id.
Split HTTP/SSE clients call `serverRequest/respond` with `{ requestId, decision }`.
Pending requests are process-local and replayed on an SSE reconnect; durable approval
events are audit history only. Session policy is exposed through
`thread/approvalPolicy/read` and `thread/approvalPolicy/write` (`ask` or `never`).

独立的 DSH App Server。它直接使用 DSH Cordis 原生服务，不依赖 Flowix bridge、`dsh-sdk-jsonrpc-server` 或 SDK extension 环境。

接口按 Codex app-server 的资源目录组织：初始化、Thread、Turn、Model、Credential、Runtime 和 Session。生产运行时、协议测试和 HTTP 测试共用同一个 dispatcher。

## 目录

```text
src/app-server/
├── server.js                 # 握手、请求队列、错误边界、方法注册
├── methods/                  # 按 JSON-RPC 资源拆分的 handlers
│   ├── thread.js
│   ├── turn.js
│   ├── model.js
│   ├── credential.js
│   ├── runtime.js
│   └── session.js
├── protocol/json-rpc.js      # JSON-RPC 校验、错误码、响应构造
├── adapters/
│   └── native-dsh-adapter.js # 唯一的 DSH 原生依赖边界
└── transports/
    ├── stdio.js
    └── http.js
```

根目录下的 `native-jsonrpc-server.js`、`native-adapter.js` 和 `http-transport.js` 仅是向后兼容导出。

## 接口目录

```text
initialize
shutdown

thread/start
thread/resume
thread/read
thread/list
thread/fork
thread/turns/list
thread/events/list
thread/close

turn/start
turn/interrupt

model/list
model/config/read
model/config/upsert
model/config/remove

credential/read
credential/set
credential/unset

runtime/capabilities
runtime/status

session/flush
session/ensure
session/prompt
session/history
session/dispose
run/cancel
```

旧的 `models/*`、`credentials/*` 和 `flowix.bridge.*` 方法名保留为迁移别名，但不参与内部能力建模。

## Transport

- stdio：JSONL，一行一个 JSON-RPC 消息。
- HTTP：`POST /rpc`。
- SSE：`GET /events?threadId=<id>&afterSeq=<seq>&clientId=<client-id>`，历史回放和实时事件使用相同的 `thread/*`、`turn/*`、`item/*` 通知格式。
- 健康检查：`GET /readyz`、`GET /healthz`。

HTTP 默认监听 `127.0.0.1`。对外暴露前应在宿主层增加鉴权和 TLS。

HTTP 多客户端通过 `x-dsh-client-id` 请求头区分连接级初始化状态；SSE 可使用同名请求头或 `clientId` 查询参数。`initialize.params.capabilities.optOutNotificationMethods` 只影响当前客户端。

同一个 Thread 的请求串行执行，不同 Thread 可并行。stdio transport 保持输入消息顺序，因此批量写入的 fork/read 等依赖请求不会抢跑。

## Cordis 挂载

```yaml
- id: dsh-appserver
  name: './src/cordis-plugin.js'
  config:
    stdio: true
```

模型与凭据服务按请求动态解析：核心 Thread/Turn 服务只要求 `agents` 和 `sessions`；模型配置需要 `settings`，模型发现需要 `llm`，凭据管理需要 `credentials`。

## 测试

```sh
npm run typecheck
npm test
npm run test:models
npm run test:http-transport
# Cross-platform runtime smokes against the locally installed Flowix DSH
# (auto-discovered from ~/Library/Application Support/Flowix/dsh/current.json,
# or set DSH_RUNTIME_ROOT to a versions/<v> runtime root):
npm run test:runtime-stdio
npm run test:runtime-http
# Legacy Windows-only runtime smokes (hardcoded dev-machine paths):
npm run test:runtime-profile
npm run test:runtime-jsonrpc
```

`test:runtime-stdio` / `test:runtime-http` 用 Flowix 安装的 DSH 作为真实 Cordis 宿主：由 `test/runtime/host.mjs` 拍平运行时自带 `dsh-base` roster（headless 裁剪的 typert 行就地 disable）生成配置，再以 `dsh-sdk-jsonrpc-demo/packaged-bin` 启动。stdio 冒烟覆盖握手、错误码、Thread/Turn/Fork、审批策略、凭据与模型配置 CRUD、session 别名与崩溃重启恢复；HTTP 冒烟覆盖 `/rpc`、`/events` SSE 回放、`afterSeq` 游标、多客户端隔离、通知 opt-out 与请求体上限。项目代码不导入或依赖 DSH SDK server。真实模型调用与审批决策环需要有效凭据，未在这些冒烟中触发。
