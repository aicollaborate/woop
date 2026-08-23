#!/usr/bin/env bash
# Build signed Tauri updater artifacts, publish them to R2, and deploy the
# stable updater manifest through the flowix-home Pages site.
#
# Required:
#   TAURI_SIGNING_PRIVATE_KEY           Tauri signer key string (modern key file contents)
#   TAURI_SIGNING_PRIVATE_KEY_PATH      or a path to the Tauri signer key file
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  optional key password
#
# Useful overrides:
#   FLOWIX_HOME_DIR          local flowix-home checkout
#   FLOWIX_TARGETS           space-separated Rust targets to collect
#   FLOWIX_R2_BUCKET         R2 bucket name (default: flowix-downloads)
#   FLOWIX_R2_PREFIX         object prefix (default: v${VERSION})
#   FLOWIX_R2_PUBLIC_BASE    public package origin
#   FLOWIX_UPDATER_ENDPOINT  manifest URL written to the production config
#   FLOWIX_SKIP_BUILD=1       collect artifacts already present in CARGO_TARGET_DIR
#   FLOWIX_PUBLISH=1          upload R2 objects and deploy Pages
#
# The default mode is build + manifest generation only. Publishing is explicit
# so a local build cannot accidentally replace the production manifest.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
export CARGO_TARGET_DIR

VERSION="$(awk -F'"' '/^version *=/{print $2; exit}' "$REPO_ROOT/app/Cargo.toml")"
FLOWIX_HOME_DIR="${FLOWIX_HOME_DIR:-$REPO_ROOT/../flowix-home}"
FLOWIX_R2_BUCKET="${FLOWIX_R2_BUCKET:-flowix-downloads}"
FLOWIX_R2_PREFIX="${FLOWIX_R2_PREFIX:-v${VERSION}}"
FLOWIX_R2_PUBLIC_BASE="${FLOWIX_R2_PUBLIC_BASE:-https://download.flowix-memo.com}"
FLOWIX_UPDATER_ENDPOINT="${FLOWIX_UPDATER_ENDPOINT:-https://flowix-memo.com/latest.json}"
FLOWIX_HOME_PROJECT="${FLOWIX_HOME_PROJECT:-flowix-home}"
FLOWIX_HOME_BRANCH="${FLOWIX_HOME_BRANCH:-main}"
RELEASE_OUT="${RELEASE_OUT:-$CARGO_TARGET_DIR/release/updater}"

if [[ "${FLOWIX_SKIP_BUILD:-0}" != "1" && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  echo "release.sh: TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required" >&2
  exit 1
fi
if [[ "${FLOWIX_PUBLISH:-0}" == "1" && -z "${FLOWIX_DSH_UPDATE_PUBLIC_KEY:-}" ]]; then
  echo "release.sh: FLOWIX_PUBLISH=1 requires FLOWIX_DSH_UPDATE_PUBLIC_KEY so signed DSH packages can be verified" >&2
  exit 1
fi
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  if [[ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
    echo "release.sh: signing key path does not exist: $TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
    exit 1
  fi
  # `tauri build` consumes Base64-encoded minisign text. A standard encrypted
  # key file has a human-readable comment plus its payload, so encode the
  # complete file as one line for the CLI.
  export TAURI_SIGNING_PRIVATE_KEY="$(base64 < "$TAURI_SIGNING_PRIVATE_KEY_PATH" | tr -d '\n')"
fi
if [[ ! -d "$FLOWIX_HOME_DIR" ]]; then
  echo "release.sh: flowix-home checkout not found at $FLOWIX_HOME_DIR" >&2
  exit 1
fi

if [[ -z "${FLOWIX_TARGETS:-}" ]]; then
  case "$(uname -s)" in
    Darwin) FLOWIX_TARGETS="aarch64-apple-darwin" ;;
    MINGW*|MSYS*|CYGWIN*) FLOWIX_TARGETS="x86_64-pc-windows-msvc" ;;
    *) FLOWIX_TARGETS="x86_64-unknown-linux-gnu" ;;
  esac
fi

rm -rf "$RELEASE_OUT"
mkdir -p "$RELEASE_OUT"

if [[ "${FLOWIX_SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> building Flowix ${VERSION}"
  cd "$REPO_ROOT"
  npm run tauri:build:production
fi

find_artifact() {
  local target="$1"
  local search_root
  for search_root in \
    "$CARGO_TARGET_DIR/$target/release/bundle" \
    "$CARGO_TARGET_DIR/release/bundle"; do
    [[ -d "$search_root" ]] || continue
    candidate="$(find "$search_root" -type f \( \
      -name '*.app.tar.gz' -o \
      -name '*.nsis.zip' -o \
      -name '*.AppImage.tar.gz' \
    \) ! -name '*.sig' -print -quit)"
    if [[ -n "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
}

platform_for_target() {
  case "$1" in
    aarch64-apple-darwin) echo "darwin-aarch64" ;;
    x86_64-apple-darwin) echo "darwin-x86_64" ;;
    x86_64-pc-windows-msvc) echo "windows-x86_64" ;;
    x86_64-unknown-linux-gnu) echo "linux-x86_64" ;;
    *) echo "" ;;
  esac
}

artifact_suffix_for_target() {
  case "$1" in
    *apple-darwin) echo "app.tar.gz" ;;
    *windows-msvc) echo "nsis.zip" ;;
    *linux-gnu) echo "AppImage.tar.gz" ;;
    *) echo "" ;;
  esac
}

declare -a MANIFEST_ROWS=()
for target in $FLOWIX_TARGETS; do
  platform="$(platform_for_target "$target")"
  suffix="$(artifact_suffix_for_target "$target")"
  [[ -n "$platform" && -n "$suffix" ]] || {
    echo "release.sh: unsupported target $target" >&2
    exit 1
  }

  source_path="$(find_artifact "$target" || true)"
  if [[ -z "$source_path" || ! -f "$source_path" ]]; then
    echo "release.sh: no updater artifact found for $target" >&2
    exit 1
  fi
  signature_path="${source_path}.sig"
  if [[ ! -f "$signature_path" ]]; then
    echo "release.sh: missing updater signature $signature_path" >&2
    exit 1
  fi

  output_name="Flowix_${VERSION}_${platform}.${suffix}"
  cp "$source_path" "$RELEASE_OUT/$output_name"
  cp "$signature_path" "$RELEASE_OUT/$output_name.sig"
  node "$REPO_ROOT/scripts/verify-flowix-package.mjs" "$RELEASE_OUT/$output_name"
  echo "==> collected $platform: $output_name"

  MANIFEST_ROWS+=("$platform|$output_name")
done

export FLOWIX_RELEASE_OUT="$RELEASE_OUT"
export FLOWIX_VERSION="$VERSION"
export FLOWIX_UPDATER_ENDPOINT
export FLOWIX_R2_PUBLIC_BASE
export FLOWIX_R2_PREFIX
export FLOWIX_HOME_DIR

node --input-type=module - "${MANIFEST_ROWS[@]}" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.FLOWIX_RELEASE_OUT;
const version = process.env.FLOWIX_VERSION;
const endpoint = process.env.FLOWIX_UPDATER_ENDPOINT;
const publicBase = process.env.FLOWIX_R2_PUBLIC_BASE.replace(/\/$/u, '');
const prefix = process.env.FLOWIX_R2_PREFIX.replace(/^\/+|\/+$/gu, '');
const homeDir = process.env.FLOWIX_HOME_DIR;
const rows = process.argv.slice(1);

const platforms = {};
for (const row of rows) {
  const separator = row.indexOf('|');
  if (separator < 0) continue;
  const platform = row.slice(0, separator);
  const name = row.slice(separator + 1);
  const signature = fs.readFileSync(path.join(out, `${name}.sig`), 'utf8').trim();
  platforms[platform] = {
    signature,
    url: `${publicBase}/${prefix}/${name}`,
  };
}

const manifest = {
  version,
  notes: `Flowix ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};
const json = `${JSON.stringify(manifest, null, 2)}\n`;
fs.writeFileSync(path.join(out, 'latest.json'), json);
fs.writeFileSync(path.join(homeDir, 'src', 'latest.json'), json);
console.log(`==> wrote ${path.join(out, 'latest.json')}`);
console.log(`==> synced ${path.join(homeDir, 'src', 'latest.json')}`);
NODE

if [[ "${FLOWIX_PUBLISH:-0}" != "1" ]]; then
  echo "==> publish skipped (set FLOWIX_PUBLISH=1 to upload R2 and deploy flowix-home)"
  exit 0
fi

WRANGLER="${WRANGLER:-$(command -v wrangler || true)}"
if [[ -z "$WRANGLER" ]]; then
  echo "release.sh: wrangler is required when FLOWIX_PUBLISH=1" >&2
  exit 1
fi

for target in $FLOWIX_TARGETS; do
  platform="$(platform_for_target "$target")"
  suffix="$(artifact_suffix_for_target "$target")"
  name="Flowix_${VERSION}_${platform}.${suffix}"
  echo "==> uploading $name to R2"
  "$WRANGLER" r2 object put "$FLOWIX_R2_BUCKET/$FLOWIX_R2_PREFIX/$name" \
    --file "$RELEASE_OUT/$name" --remote
  "$WRANGLER" r2 object put "$FLOWIX_R2_BUCKET/$FLOWIX_R2_PREFIX/$name.sig" \
    --file "$RELEASE_OUT/$name.sig" --remote
done

echo "==> building flowix-home"
npm --prefix "$FLOWIX_HOME_DIR" run build
echo "==> deploying flowix-home"
"$WRANGLER" pages deploy "$FLOWIX_HOME_DIR/_site" \
  --project-name "$FLOWIX_HOME_PROJECT" --branch "$FLOWIX_HOME_BRANCH"

echo "==> published Flowix ${VERSION}"
echo "    manifest: $FLOWIX_UPDATER_ENDPOINT"
echo "    artifacts: $FLOWIX_R2_PUBLIC_BASE/$FLOWIX_R2_PREFIX/"
