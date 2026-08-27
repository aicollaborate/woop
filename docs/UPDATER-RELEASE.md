# Flowix updater release

Flowix ships three updater surfaces that work together:

- **Per-platform updater manifests** under stable R2 paths, served directly to
  the in-app Tauri updater. Each one advertises exactly one release platform
  group's binaries and pins its own top-level `version`.
- **A combined site manifest** at `flowix-memo.com/latest.json`, consumed by the
  flowix-home Pages site for the download buttons.
- **Version-prefixed R2 artifacts** (`v<version>/...`) that the manifests point
  at. These are immutable per release.

Per-platform updater manifests live on R2 (under `${FLOWIX_R2_PUBLIC_BASE}/${FLOWIX_R2_UPDATER_PREFIX}/`) so each release can overwrite the stable URL without rebuilding flowix-home. The split exists so that macOS and Windows can ship on independent cadences —
macOS can publish `1.3.0` while Windows stays on `1.2.4` without confusing
either client into a self-install loop.

## Manifest layout

| Manifest                          | Consumer             | Stable URL                                       |
| --------------------------------- | -------------------- | ------------------------------------------------ |
| `updater/macos/latest.json`       | macOS Tauri updater  | `https://download.flowix-memo.com/updater/macos/latest.json`      |
| `updater/windows/latest.json`     | Windows Tauri updater| `https://download.flowix-memo.com/updater/windows/latest.json`    |
| `updater/linux/latest.json`       | Linux Tauri updater  | `https://download.flowix-memo.com/updater/linux/latest.json`      |
| `flowix-memo.com/latest.json`     | flowix-home Pages    | (deployed via Wrangler Pages, not R2)            |

Each per-platform manifest's `platforms` block contains only its own group:

| Manifest                | `platforms` keys                        |
| ----------------------- | --------------------------------------- |
| `updater/macos/...`     | `darwin-aarch64`, `darwin-x86_64`       |
| `updater/windows/...`   | `windows-x86_64`                        |
| `updater/linux/...`     | `linux-x86_64`                          |

The Tauri updater picks the first endpoint that returns a manifest containing
its current OS-arch key, so a misconfigured binary that points at the wrong
group manifest will fail `check()` rather than silently offering nothing.

## Release scope

`scripts/release.sh` infers the release scope from `FLOWIX_TARGETS`:

- **Full release** — `FLOWIX_TARGETS` covers all three groups (macos, windows,
  linux). The script writes per-group manifests, uploads them to R2, **and**
  regenerates the combined `site-latest.json` so flowix-home is rebuilt and
  redeployed.
- **Partial release** — `FLOWIX_TARGETS` covers only one or two groups. The
  script writes the covered per-group manifests and uploads them to R2, but
  skips the combined site manifest step. flowix-home is left alone, so the
  download buttons keep pointing at the laggard group's previous release.

This keeps the website honest: when only mac is published, the Windows download
button still serves the last full Windows release instead of a stale URL.

## Environment overrides

| Variable                            | Default                                              | Notes |
| ----------------------------------- | ---------------------------------------------------- | ----- |
| `FLOWIX_UPDATER_ENDPOINT_MACOS`     | `https://download.flowix-memo.com/updater/macos/latest.json`          | Injected into `plugins.updater.endpoints` for darwin builds |
| `FLOWIX_UPDATER_ENDPOINT_WINDOWS`   | `https://download.flowix-memo.com/updater/windows/latest.json`        | Injected for win32 builds |
| `FLOWIX_UPDATER_ENDPOINT_LINUX`     | `https://download.flowix-memo.com/updater/linux/latest.json`          | Injected for linux builds |
| `FLOWIX_UPDATER_ENDPOINT`           | `https://flowix-memo.com/latest.json`                | Legacy combined manifest URL (only published on full releases) |
| `FLOWIX_R2_UPDATER_PREFIX`          | `updater`                                            | R2 key prefix for per-platform manifests |
| `FLOWIX_R2_PREFIX`                  | `v${VERSION}`                                        | R2 key prefix for versioned artifacts (unchanged) |
| `FLOWIX_R2_BUCKET`                  | `flowix-downloads`                                   | R2 bucket (unchanged) |
| `FLOWIX_R2_PUBLIC_BASE`             | `https://download.flowix-memo.com`                   | Public origin for artifact URLs (unchanged) |

## Publish flow

```bash
# Full release from a freshly built matrix
FLOWIX_SKIP_BUILD=1 \
FLOWIX_TARGETS="aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc x86_64-unknown-linux-gnu" \
FLOWIX_PUBLISH=1 \
bash scripts/release.sh
```

```bash
# Partial release — only Windows (e.g. when macOS is held back)
FLOWIX_SKIP_BUILD=1 \
FLOWIX_TARGETS="x86_64-pc-windows-msvc" \
FLOWIX_PUBLISH=1 \
bash scripts/release.sh
```

Both flows upload the per-group manifest to the matching stable R2 path so the
in-app updater picks up the new version immediately. Only the full release
also deploys the combined site manifest to flowix-home.

## Verifying a manifest locally

`scripts/verify-updater-release.mjs` validates a single manifest against the
artifacts on disk:

```bash
node scripts/verify-updater-release.mjs \
  --release-dir "$RELEASE_OUT" \
  "$RELEASE_OUT/updater/macos/latest.json" \
  "$VERSION" "v$VERSION" \
  darwin-aarch64 darwin-x86_64
```

`--release-dir` defaults to the manifest's parent directory, but per-group
manifests live under `updater/<group>/` while artifacts are staged at the
top level of `$RELEASE_OUT`, so the override is required in this flow.
