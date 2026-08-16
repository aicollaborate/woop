# DeepSeek Harness upstream

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Pinned commit: `47f943859bef60e4160492346772ded9b24f765a`
- Imported version: `0.1.0-rc.5`
- License: MIT (see `vendor/deepseek-harness/LICENSE`)

`vendor/deepseek-harness` is a complete source snapshot. The Flowix host
imports the upstream TypeScript SDK client and protocol directly. The runtime
build reuses the upstream SDK runtime closure and executable build script.

Flowix applies five small patches after import:

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

Update the snapshot only through `scripts/sync-upstream.mjs`; the script checks
the requested commit before replacing the tree.
