# Flowix DSH bridge

## Ownership

`@flowix/dsh-flowix-bridge` is a DSH profile bundle. It runs inside the DSH
runtime and only knows DSH concepts: sessions, agents, turns, tools, usage,
profiles, and native session events.

`dsh-flowix-memory` remains a separate DSH MCP bundle. It is the agent-to-
Flowix business capability (`flowix-cli mcp`), while this bridge is the
Flowix-to-DSH control plane.

The Flowix desktop side owns the corresponding `FlowixDshBridgeClient` and the
conversion from native bridge events to `AgentChunk`. The runtime plugin never
imports React, Tauri, SQLite, Flowix thread models, or `AgentChunk`.

## Wire surface

The runtime SDK JSON-RPC server exposes these methods only when the bridge
plugin is mounted:

| Method | Purpose |
| --- | --- |
| `flowix.bridge.capabilities` | Negotiate protocol version and capabilities |
| `flowix.bridge.status` | Read provider/model/cwd and live session status |
| `flowix.bridge.session.ensure` | Create or recover one DSH agent session |
| `flowix.bridge.session.prompt` | Enqueue a text prompt into a DSH session |
| `flowix.bridge.session.dispose` | Dispose a session owned by the SDK server |
| `flowix.bridge.run.cancel` | Cooperatively cancel the current DSH activity |

Notifications are native and lossless:

```text
flowix.bridge.ready
flowix.bridge.event { kind: "session.event", sessionId, event }
flowix.bridge.event { kind: "agent.status", sessionId, status }
```

The existing host protocol remains the process boundary consumed by Rust. Its
`runtime.bridge.*` methods are a narrow forwarding surface for capability and
status negotiation; `run.event` remains the compatibility projection used by
the current Flowix UI.

## Profile loading

`profile/flowix` is the canonical source and release payload for this bridge;
there is no second copy under `bundles/`. The profile manifest and the
`@flowix/dsh-flowix-bridge` package are maintained together so the DSH loader
and the standalone archive always consume the same files.

The profile starts with upstream's `@deepseek-ai/dsh-base`. Its core service
roster is therefore updated by DSH itself. The bridge bundle is the only layer
that inserts Flowix's SDK server/control service and overrides headless sandbox
policy; unrelated third-party bundles remain ordinary later profile layers.

The standalone DSH archive ships a normal `profile/flowix` tree containing the
profile manifest and `@flowix/dsh-flowix-bridge` bundle. The host installs that
profile payload into `$DSH_HOME/profiles/flowix` when the runtime starts, so
the official DSH loader resolves the bridge from a profile-local
`node_modules` package. Existing profile fields and user patch layers are
preserved; only the Flowix-owned bundle files are refreshed.

Development sidecars resolve the same profile payload from the host source
tree. `FLOWIX_DSH_PROFILE_SOURCE` can explicitly select another profile
payload for packaging and integration tests.

The upstream SDK server extension is kept as a downstream patch in
`patches/flowix-dsh-bridge-runtime.patch`; it is a product-neutral method
router/control seam and contains no `flowix.*` protocol implementation. The
bridge bundle owns capability, status, session, prompt, dispose and cancel
semantics. `upstream.lock.json` records the seam so the runtime build applies
it reproducibly.

## Migration boundary

The current high-level SDK run path and `run.event → AgentChunk` projection
remain intact in this first implementation. The bridge client is now the
stable control-plane seam. The next migration can move prompt/cancel streaming
from `DeepSeekHarness.run()` to the bridge methods without changing the Rust
or React contracts, because both surfaces carry the same DSH session identity
and native event envelopes.
