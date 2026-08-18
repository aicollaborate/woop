# Flowix Harness host

`dsh-host` is the process boundary between Flowix Desktop and the vendored
Harness SDK. Tauri bundles one dual-mode Node SEA executable. Its default mode
is the long-lived host using the official TypeScript SDK client; runtime
children execute the same file with `FLOWIX_DSH_RUNTIME_MODE=1`. Harness is an
agent runtime, so its model route is supplied
by Flowix's selected provider configuration and is not limited to DeepSeek
models.

```text
Flowix UI -> Tauri/Rust -> dsh-host -> official SDK client -> dsh-host(runtime mode)
                events <- JSON-RPC v1 <- session notifications <-|
```

The complete pinned upstream snapshot is under
`vendor/deepseek-harness`; see `UPSTREAM.md` for its commit and license.

## Build

Install the root dependency tree and the vendored Harness dependency closure
once:

```bash
npm install
npm --prefix app/flowix-dsh-host run vendor:install
```

The host package uses the root `esbuild` and `@yao-pkg/pkg` installations.
The vendored Harness tree intentionally keeps its own pnpm-managed
`node_modules` because its workspace and runtime package resolution are
independent from Flowix's root npm tree.

Build and stage native sidecars for the current host:

```bash
npm run dsh:build
```

Root Tauri builds call the sidecar build once before packaging, while
`npm run tauri:dev` rebuilds the development host before starting Tauri. This
prevents an old `target/debug/dsh-host` sidecar from shadowing the current host
implementation.

On macOS, the production build uses `npm run dsh:build:macos` to stage both
Apple Silicon and Intel products. The resulting target-triple filenames live
under `app/flowix-desktop/binaries/` and are intentionally gitignored. The
builder deploys the upstream generic runtime, prunes it to the transitive graph
rooted at Flowix's Cordis composition, packages the host and runtime roles into one SEA, strips
local symbols, and signs the final Mach-O.

For host-only development, run `npm --prefix app/flowix-dsh-host run build`.
The generated host is written to `.build/flowix-dsh-host/dsh-host.cjs`; Rust
uses it when no packaged sidecar is available.
The dev Tauri config intentionally does not require DSH externalBin files;
build `dsh-host` plus the vendored runtime when testing DSH locally. Production
configs add all target-triple sidecars automatically.

## Protocol

Standard input and output carry newline-delimited JSON-RPC 2.0 only. Protocol
v1 exposes:

- `host.initialize`, `host.ping`, `host.shutdown`
- `runtime.ensure`, `runtime.status`, `runtime.dispose`
- `run.start`, `run.cancel`
- `run.event` notifications for text, reasoning, tools, usage and terminal state

Diagnostics go to stderr. A thread has at most one active run; different
threads can execute in parallel. Cancelling a run closes and discards that
thread's runtime, making cancellation deterministic even though the upstream
SDK protocol has no native abort request yet. Completed runtimes are bounded by
an idle LRU and TTL so opening many threads does not retain an unbounded number
of Node processes.

## Runtime and persistence

`config/flowix.cordis.yml` is the Flowix-owned headless composition. It mounts
the generic `dsh-llm-pi-ai` provider adapter and is
embedded in the host executable and materialized into the session root in
packaged builds, so no source-tree resource is required. Session JSONL and
checkpoints are stored beneath the Flowix user-config directory in
`dsh/sessions/` and reused through Flowix's persisted thread-to-session mapping.
The persistence root follows the official Harness layout: project directories
and encoded Harness session ids are created directly beneath `dsh/sessions/`;
Flowix keeps its thread-to-Harness-session mapping separately and does not add
an extra per-thread directory layer.

The runtime uses one internal `flowix` route. Flowix passes the selected
provider name, model, API protocol, endpoint and credential to each child
runtime through a trusted environment boundary. OpenAI Chat Completions,
OpenAI Responses and Anthropic Messages are supported.

Development overrides:

- `FLOWIX_DSH_HOST_PATH`: host executable or built `.mjs`
- `FLOWIX_DSH_RUNTIME_PATH`: Harness runtime executable
- `FLOWIX_DSH_CORDIS_CONFIG`: alternate Cordis composition
- `FLOWIX_DSH_SESSION_ROOT`: session persistence root
- `FLOWIX_DSH_HOME`: harness home passed to each runtime as `DSH_HOME`
- `FLOWIX_DSH_ROOT`: source/development host root
- `FLOWIX_DSH_MAX_IDLE_RUNTIMES`: retained idle runtime cap (default `2`)
- `FLOWIX_DSH_IDLE_TTL_MS`: idle runtime lifetime in milliseconds (default `300000`)
- `FLOWIX_DSH_STRIP=0`: disable release-sidecar symbol stripping for diagnostics

## Security boundary

The Rust launcher clears the parent environment and passes an allowlist plus
the selected provider credential. The host repeats an allowlist for each
runtime. API keys never cross the JSON-RPC protocol or enter persisted events.
Permission
modes fail closed to `read-only`; the Cordis approval policy is `never` until
the SDK exposes an approval response protocol.

Flowix's `workspacePaths` is mapped to the Harness workspace-root set. Under
`workspace-write`, file writes are allowed in every selected root (plus the
platform temporary area); `cwd` remains the primary working directory. Under
`read-only`, all file writes are denied. This is a file-effect policy only:
the current Harness sandbox does not make the selected roots a read boundary,
and does not isolate network access or process visibility. The UI therefore
describes these directories as an AI workspace, not as a secure read allowlist.
The Host and runtime environment deliberately do not forward `SSH_AUTH_SOCK`.

## Verification

```bash
npm --prefix app/flowix-dsh-host run check
npm --prefix app/flowix-dsh-host run test:e2e
npm --prefix app/flowix-dsh-host run test:sidecar:e2e
cargo test -p flowix-desktop deepseek_harness --lib
```

The fixture E2E covers the official SDK client and event normalization. The
sidecar E2E additionally runs both process roles of the packaged executable against a
local mock OpenAI-compatible SSE endpoint, exercising persistence and the real
Harness agent loop without using a real API key or consuming model quota.
