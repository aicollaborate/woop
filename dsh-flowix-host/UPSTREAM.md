# DeepSeek Harness upstream

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Pinned commit: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`)
- Imported version: `0.1.0-rc.5`
- License: MIT (see `.build/upstream/deepseek-harness/LICENSE`)

The upstream checkout is not committed inside the Flowix repository. The
commit above is fetched into `.build/upstream/deepseek-harness` and exposed to
the DSH build through the ignored `vendor/deepseek-harness` compatibility link.
The generated checkout stores both a source-tree digest and a digest of the
locked patch set; a matching commit marker alone is never trusted.
The Flowix host imports the upstream TypeScript SDK client and protocol
directly. The runtime build reuses the upstream SDK runtime closure and
executable build script.

Flowix applies one consolidated rc.2 downstream patch after checkout. Product-specific
runtime behavior belongs in profile bundles; patches are limited to packaging,
generic SDK extension seams, and upstream capabilities not yet exposed by a
public API:

The patch file names are retained for release-history continuity, but their
contents contain no Flowix protocol names or product policy. A regression test
enforces this boundary; Flowix semantics live in profile bundles.

- `patches/runtime-bash-sandbox.patch` adds the upstream sandboxed bash
  provider to the SDK runtime closure because the stock Python SDK composition
  uses `dsh-bash-local`, while Flowix's permission modes require the enforcing
  `dsh-bash-sandbox` provider.
- `patches/production-deploy-postinstall.patch` defers the development-only
  Lefthook package import until after CI has opted out. The upstream production
  runtime deploy excludes that devDependency, so a static import would make a
  clean sidecar rebuild fail before the installer can honor its CI guard.
- `patches/downstream-single-exe-options.patch` adds opt-in downstream build
  flags for pruning a deployed closure to selected package roots and embedding
  a CommonJS launcher beside the standard JSON-RPC runtime. Upstream defaults
  and Python SDK artifacts are unchanged when those flags are absent.
- `patches/agent-presets-sdk-server.patch` makes the SDK JSON-RPC server join
  each new agent to the preset selected by `DSH_AGENT_PRESET`, persisting the
  selection as `agentPreset` in the session metadata. This is what lets Flowix
  expose the shipped `standard`, `code`, `minimal`, and `cordis` compositions
  through the Agent Thread Card.
- `patches/strip-dev-only-artifacts.patch` strips dev-only files (`.map`,
  `.ts`, `.d.ts`) and non-target native prebuilds (Windows `node-pty`
  prebuilds) from the staged closure before packaging, shrinking the single
  executable. Windows is a non-goal, so those prebuilds are dead weight on the
  macOS and Linux targets.
- `patches/sdk-runtime-mcp-client.patch` adds `@deepseek-ai/dsh-mcp-client`
  to the `python/sdk-runtime` deploy manifest so the MCP client bridge is part
  of the generic deployed closure. Flowix's composition mounts one instance
  (`dsh-flowix-memory`) that connects to the bundled `flowix-cli mcp` server, so the
  runtime needs the package inside the pruned single executable.
- `patches/flowix-profile-runtime-v5.patch` extends the upstream app-boot
  JSON-RPC runner to compose the official `DSH_PROFILE=flowix` bundle layers
  and resolve their packages from `~/.dsh/profiles/flowix`. The official `dsh`
  CLI is included in the staged runtime closure and uses the upstream
  `dsh plugin` implementation for profile management.
- `patches/flowix-dsh-bridge-runtime.patch` adds a product-neutral SDK JSON-RPC
  extension seam. It contains no Flowix method names or business protocol;
  `@flowix/dsh-flowix-bridge` owns those methods through the seam.
- `patches/session-resume-runtime.patch` lets the SDK server reopen a supplied
  persisted session id instead of silently replacing it.

Update the upstream input only through `scripts/sync-upstream.mjs`; the script
reads `upstream.lock.json`, checks the resolved commit, applies every listed
patch, and replaces the generated checkout atomically. Do not commit the
checkout or its `node_modules`.
