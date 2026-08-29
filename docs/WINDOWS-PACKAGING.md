# Windows packaging runbook

Flowix, DSH, and `flowix-cli` are separate build products. Flowix embeds only
`flowix-cli`; DSH is downloaded and updated independently.

## Prerequisites

- Node.js 24 for DSH builds (the Flowix frontend itself also supports the CI
  Node version declared by the workflow)
- Rust MSVC target `x86_64-pc-windows-msvc`
- Visual Studio C++ Build Tools and Windows SDK
- Git Bash for the shell-based release helpers
- `signtool.exe` and the Windows signing certificate for signed releases

Install JavaScript dependencies from a clean checkout with `npm ci`. DSH also
uses its locked private pnpm installation; its build script prepares this
automatically through Corepack.

## 1. Standalone CLI

```bash
npm run cli:build:prod
```

The command builds `app/flowix-cli` in release mode, stages the target-specific
binary at:

```text
app/flowix-desktop/binaries/flowix-cli-x86_64-pc-windows-msvc.exe
```

and creates the host development copy `flowix-cli.exe`. When
`WINDOWS_CERTIFICATE` is present, the staged target-specific binary is signed
and verified by `scripts/sign-cli.sh`.

The CLI does not have a separate installer. Its distributable form is the
sidecar embedded in the Flowix NSIS package.

## 2. Standalone DSH

```bash
npm run dsh:build:prod -- --target=node24-windows-x64
npm run dsh:package -- --targets=node24-windows-x64
```

This performs the following fixed sequence:

1. Build the managed Node 24 Windows x64 runtime bundle.
2. Keep the private Node executable, pnpm, host, runtime dependency closure,
   Flowix profile, bridge, and memory plugin.
3. Remove only non-target `node-pty` ARM64 files and PDB debug symbols.
4. Create and health-check the archive.
5. Write its SHA-256, byte size, build ID, and URL into the Windows platform
   manifest.

Outputs:

```text
.build/releases/dsh/Flowix-DSH_<version>_node24-windows-x64.tar.gz
.build/releases/dsh/dsh-latest.json
.build/releases/dsh/platforms/windows/latest.json
```

The Windows workflow may publish its versioned archive and update only the
Windows DSH updater channel. Other platform channels remain unchanged. To
publish manually, use:

```bash
DSH_PUBLISH=1 FLOWIX_DSH_SKIP_BUILD=1 \
FLOWIX_DSH_TARGETS=node24-windows-x64 \
bash scripts/release-dsh.sh
```

Publishing only needs Wrangler/R2 credentials — DSH artifacts are not
minisign-signed; the in-app updater pins each release by SHA-256. Each
platform release updates only its stable
`dsh/{macos|windows|linux}/latest.json` pointer.

## 3. Flowix Windows installer

```bash
npm run tauri:build:prod -- --platform win32
```

This is the canonical local entry point. It:

1. Derives the DSH update public key when it is not already supplied.
2. Builds and stages the Windows `flowix-cli` sidecar.
3. Merges the base, Windows, and production Tauri configurations into the
   ignored `tauri.windows.production.local.json` file.
4. Builds the frontend and Rust desktop application.
5. Produces the NSIS installer and updater artifacts.

Signed production builds require the Tauri updater signing key, the Windows
certificate inputs used by the CLI signer, and `WINDOWS_CERT_THUMBPRINT` used
by Tauri. For a local build, import that PFX into the current user's Windows
certificate store before running Tauri; CI performs this import explicitly.
`FLOWIX_ALLOW_UNSIGNED=1` is only for local package-content checks; it disables
updater artifacts.

The target-specific CLI staging file is a required Tauri build input. Flowix
package verification additionally confirms that the updater archive does not
contain DSH. Use the generated updater archive with:

```bash
node scripts/verify-flowix-package.mjs <Flowix-NSIS-updater.zip>
```

For a signed Windows archive, additionally run:

```powershell
powershell -File scripts/verify-windows-release.ps1 -Artifact <Flowix-NSIS-updater.zip>
```

## Release invariants

- Versions in `app/Cargo.toml` and `app/flowix-desktop/tauri.conf.json` must
  match before a Flowix release.
- The DSH version comes from `dsh-flowix-host/package.json` and is intentionally
  independent of the Flowix application version.
- Flowix must contain `flowix-cli` but must never contain DSH host/runtime/UI
  files.
- DSH must report `includesUi: false` and pass the package health check.
- DSH stable manifests are platform-specific under `dsh/{macos|windows|linux}/latest.json`.
- Do not reuse old files under `app/flowix-desktop/binaries` when validating a
  clean release. The CLI build step must recreate the target-specific sidecar.

## Updater release flow

See [`docs/UPDATER-RELEASE.md`](UPDATER-RELEASE.md) for the per-platform
updater manifest layout, partial vs. full release semantics, and the env
variables that `scripts/release.sh` consumes.
