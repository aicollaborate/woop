# Flowix Harness host and Runtime

`dsh-host` is the process boundary between Flowix Desktop and the pinned
Harness SDK. Flowix downloads this dual-mode Node SEA only after the user
chooses to install DSH. Its default mode is the long-lived host using the
official TypeScript SDK client; runtime children execute the same file with
`DSH_EMBEDDED_RUNTIME_MODE=1`. Harness is an agent runtime, so its model route is supplied
by the official `llm-pi-ai.providers` settings section and is not limited to
DeepSeek models.

```text
Flowix UI -> Tauri/Rust -> downloaded dsh-host -> official SDK client -> dsh-host(runtime mode)
                events <- JSON-RPC v1 <- session notifications <-|
```

The upstream source is fetched at the commit recorded in
`upstream.lock.json` into `.build/upstream/deepseek-harness` and exposed to
the local build through an ignored compatibility link at
`vendor/deepseek-harness`; see `UPSTREAM.md` for its commit and license.

The DSH runtime is released independently from the Flowix Tauri application.
Its archive contains the JSON-RPC host, the packaged headless Harness runtime,
the `dsh-flowix-memory` MCP bundle, and the `profile/flowix` profile bundle
containing `@flowix/dsh-flowix-bridge`. It mounts no browser server or UI
surface; UI-only DSH profile bundles are outside the Flowix host contract.

## Build

Install the root dependency tree and the pinned Harness dependency closure
once:

```bash
npm install
npm --prefix flowix-dsh-host run vendor:install
```

`vendor:install` fetches the locked upstream commit when it is absent, applies
the Flowix patches, and installs the Harness workspace's own pnpm-managed
`node_modules`. The upstream checkout and its dependency closure are generated
under `.build/` and are not committed to the Flowix repository. The Harness
workspace remains separate from Flowix's root npm tree because its package
resolution and build graph are independent.

To refresh the checkout explicitly, update `upstream.lock.json` and run:

```bash
npm --prefix flowix-dsh-host run vendor:sync
```

Build and stage native sidecars for the current host:

```bash
npm run dsh:build
```

Create a standalone DSH archive and manifest:

```bash
npm run dsh:package
```

The output is written to `.build/releases/dsh/`. Flowix downloads this
archive into a versioned platform data directory and starts `dsh-host` over
stdin/stdout JSON-RPC; end users do not need Node, npm, or pnpm.

`npm run tauri:dev` rebuilds the development host before starting Tauri. This
prevents an old `target/debug/dsh-host` sidecar from shadowing the current host
implementation.

On macOS, the standalone DSH release uses `npm run dsh:build:macos` to stage
the requested Apple Silicon and Intel products. These are release inputs for
the independently downloaded DSH archive; they are not Tauri externalBin
files and are never included in the Flowix application. The builder deploys
the upstream generic runtime, prunes it to the transitive graph rooted at the
official base plus Flowix profile bundles, packages the host and runtime roles into one SEA,
strips local symbols, and signs the final Mach-O.

For host-only development, run `npm --prefix flowix-dsh-host run build`.
The generated host is written to `.build/flowix-dsh-host/dsh-host.cjs`; Rust
uses it when no packaged sidecar is available.
The dev Tauri config intentionally does not require DSH externalBin files;
build `dsh-host` plus the generated Harness runtime when testing DSH locally. Production
Flowix packages download DSH separately.

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

`config/flowix.cordis.yml` is an empty profile root embedded in the host
executable. The official `@deepseek-ai/dsh-base` bundle owns the core runtime
roster; the single `@flowix/dsh-flowix-bridge` bundle owns Flowix's SDK entry
point and deployment-policy overrides. This keeps core plugin additions and
service contracts aligned with upstream instead of duplicating its roster.
The native `dsh-llm-pi-ai` adapter comes from that official base. Session JSONL and
checkpoints are stored beneath the Flowix user-config directory in
`~/.dsh/sessions/` and reused through Flowix's persisted thread-to-session mapping.
The persistence root follows the official Harness layout: project directories
and encoded Harness session ids are created directly beneath `~/.dsh/sessions/`;
Flowix keeps its thread-to-Harness-session mapping separately and does not add
an extra per-thread directory layer.

The runtime uses the native `llm-pi-ai` provider route stored in the official
`settings.yaml` document. `deepseek`, `openai`, `anthropic`, catalog routes,
and custom routes are all handled by the same adapter; Flowix does not create
a provider alias. An absent or locally unavailable route fails explicitly and
the user is directed to reconfigure it in Models. OpenAI Chat Completions,
OpenAI Responses and Anthropic Messages are supported. The one-shot
`models.discover` probe is an exception: its draft `apiKey` is sent as a
JSON-RPC parameter, used only for that probe, and is neither persisted nor
included in runtime events.

### Flowix bundle

The standalone archive ships two separate Flowix layers over the official
`@deepseek-ai/dsh-base` bundle:

- `dsh-flowix-memory/` is the independent MCP bundle used by the agent.
- `profile/flowix/` is a normal DSH profile containing the
  `@flowix/dsh-flowix-bridge` bundle used by the Flowix host.

The host copies the profile payload into the selected DSH_HOME on first use,
preserving existing user fields and patch layers. It does not run npm or pnpm,
and only maintains the namespaced `profiles/flowix` profile; DSH binaries and
all other user profiles are left untouched. Existing
`~/.dsh` sessions and settings remain the persistence home for the Harness.

Third-party headless bundles are managed by the official profile command and
are never rewritten by Flowix:

```bash
dsh plugin --profile flowix add <npm-package|git-url|local-path>
dsh plugin --profile flowix update
dsh plugin --profile flowix remove <package>
```

Flowix Preferences delegates these operations to the same official CLI and
shows the resulting profile inventory. The current upstream CLI forwards
dependency operations to `pnpm`, so plugin management requires `pnpm` on PATH;
running the already-installed runtime does not. UI-only DSH bundles may be
installed in other profiles but are unsupported by Flowix's headless profile.

Development overrides:

- `FLOWIX_DSH_HOST_PATH`: host executable or built `.mjs`
- `FLOWIX_DSH_RUNTIME_PATH`: Harness runtime executable
- `FLOWIX_DSH_CORDIS_CONFIG`: alternate Cordis composition
- `FLOWIX_DSH_SESSION_ROOT`: session persistence root
- `DSH_HOME`: official Harness home override (normally resolved as `~/.dsh`)
- `FLOWIX_DSH_ROOT`: source/development host root
- `FLOWIX_DSH_PROFILE_SOURCE`: explicit profile/flowix payload for development or packaging
- `FLOWIX_DSH_MAX_IDLE_RUNTIMES`: retained idle runtime cap (default `2`)
- `FLOWIX_DSH_IDLE_TTL_MS`: idle runtime lifetime in milliseconds (default `300000`)
- `FLOWIX_DSH_STRIP=0`: disable release-sidecar symbol stripping for diagnostics

## Security boundary

The Rust launcher clears the parent environment and passes an allowlist plus
the selected provider credential. The host repeats an allowlist for each
runtime. Runtime API keys do not cross JSON-RPC; the one-shot
`models.discover` probe may receive a draft key in its request parameters,
but the host does not persist it or emit it in events. Permission modes fail
closed to `read-only`; the Cordis approval policy is `never` until
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
npm --prefix flowix-dsh-host run check
npm --prefix flowix-dsh-host run test:e2e
npm --prefix flowix-dsh-host run test:sidecar:e2e
cargo test -p flowix-desktop deepseek_harness --lib
```

The fixture E2E covers the official SDK client and event normalization. The
sidecar E2E additionally runs both process roles of the packaged executable against a
local mock OpenAI-compatible SSE endpoint, exercising persistence and the real
Harness agent loop without using a real API key or consuming model quota.
