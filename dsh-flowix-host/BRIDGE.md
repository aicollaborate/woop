# Flowix DSH bridge

## Ownership

`@flowix/dsh-flowix-bridge` is a DSH profile bundle. It runs inside the DSH
runtime and only knows DSH sessions, agents, turns, tools, usage, persistence,
and native session events. It does not import React, Tauri, SQLite, Flowix
thread models, or `AgentChunk`.

The Desktop host owns protocol validation and the projection from native DSH
events to Flowix messages. `dsh-flowix-memory` remains a separate agent-facing
MCP bundle and is not part of conversation persistence.

## Wire surface

The SDK JSON-RPC server exposes these methods when the bridge is mounted:

| Method | Purpose |
| --- | --- |
| `flowix.bridge.capabilities` | Negotiate protocol and capabilities |
| `flowix.bridge.status` | Read live runtime and session status |
| `flowix.bridge.session.ensure` | Create or recover one DSH session |
| `flowix.bridge.session.prompt` | Send model text and persist separate display text/client identity |
| `flowix.bridge.session.history` | Inspect the durable DSH event log |
| `flowix.bridge.session.dispose` | Dispose a live SDK-owned session |
| `flowix.bridge.run.cancel` | Cancel current DSH activity |

The bridge emits lossless native notifications:

```text
flowix.bridge.ready
flowix.bridge.event { kind: "session.event", sessionId, event }
flowix.bridge.event { kind: "agent.status", sessionId, status }
```

## Profile loading

`profile/flowix` is the canonical source and release payload. The host installs
that profile under `$DSH_HOME/profiles/flowix`; existing user-owned profile
fields remain intact while Flowix-owned bundle files are refreshed.

The generic SDK extension seam is maintained in
`patches/flowix-dsh-bridge-runtime.patch`. The bridge bundle owns all
`flowix.bridge.*` behavior.

## History boundary

DSH is the sole durable source for DeepSeek Harness conversations. A history
read uses the mapped DSH session id directly and does not initialize a model,
resolve a provider, or fall back to Flowix SQLite events.

The host projects only completed turns from append-origin surface events and
pins multi-page reads to one event-log snapshot. Replacement surface nodes are
model-context rewrites and never replace messages in the human transcript.
