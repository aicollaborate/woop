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
#   FLOWIX_PUBLISH=1          publish a complete prebuilt four-platform set
#
# This is the only production publication path for the Flowix updater. The
# GitHub release workflow creates draft artifacts but does not update the
# configured updater endpoint. The default mode here is build + manifest
# generation only; publishing is explicit so a local build cannot accidentally
# replace the production manifest.

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
if [[ "${FLOWIX_PUBLISH:-0}" == "1" ]]; then
  if [[ "${FLOWIX_SKIP_BUILD:-0}" != "1" ]]; then
    echo "release.sh: production publishing requires FLOWIX_SKIP_BUILD=1 and a complete prebuilt platform set" >&2
    exit 1
  fi
  for required in aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc x86_64-unknown-linux-gnu; do
    if [[ " $FLOWIX_TARGETS " != *" $required "* ]]; then
      echo "release.sh: production manifest is missing required target $required" >&2
      exit 1
    fi
  done
fi

rm -rf "$RELEASE_OUT"
mkdir -p "$RELEASE_OUT"

if [[ "${FLOWIX_SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> building Flowix ${VERSION}"
  cd "$REPO_ROOT"
  npm run tauri:build:prod
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
      -name '*-setup.exe' -o \
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
    *windows-msvc) echo "nsis.exe" ;;
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

// x-flowix-installers: 官网下载弹窗专用扩展块,Tauri updater 忽略未知字段。
// `platforms` 只允许本次全局版本的构建(塞旧版本会让客户端无限重装),
// 滞后平台(如 Windows 未跟上)由这里从上一版 manifest 结转并自带 version。
const installers = {};
const DMG_TRIPLES = {
  'darwin-aarch64': ['aarch64-apple-darwin', `Flowix-${version}-macOS-Apple-Silicon.dmg`],
  'darwin-x86_64': ['x86_64-apple-darwin', `Flowix-${version}-macOS-Intel.dmg`],
};
for (const platform of Object.keys(platforms)) {
  const entry = {
    version,
    url: platforms[platform].url,
    sizeBytes: fs.statSync(path.join(out, rows.find(r => r.startsWith(`${platform}|`)).split('|')[1])).size,
  };
  const dmg = DMG_TRIPLES[platform];
  if (dmg) {
    // 官网分发 DMG(updater 归档只供 App 内更新);发布流程需把营销命名的
    // DMG 上传到同前缀,否则官网会退回模板静态链接。
    entry.url = `${publicBase}/${prefix}/${dmg[1]}`;
    const localDmg = path.join(process.env.CARGO_TARGET_DIR || '', dmg[0], 'release', 'bundle', 'dmg');
    try {
      const found = fs.readdirSync(localDmg).find(f => f.endsWith('.dmg'));
      if (found) entry.sizeBytes = fs.statSync(path.join(localDmg, found)).size;
    } catch (_) { /* DMG 不在本机时保留 updater 产物大小 */ }
  }
  installers[platform] = entry;
}
try {
  const previous = JSON.parse(fs.readFileSync(path.join(homeDir, 'src', 'latest.json'), 'utf8'));
  for (const [platform, entry] of Object.entries(previous['x-flowix-installers'] || {})) {
    if (!installers[platform] && entry && typeof entry.url === 'string') installers[platform] = entry;
  }
} catch (_) { /* 首次发布或无上一版 manifest */ }

const manifest = {
  version,
  notes: `Flowix ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
  'x-flowix-installers': installers,
};
const json = `${JSON.stringify(manifest, null, 2)}\n`;
fs.writeFileSync(path.join(out, 'latest.json'), json);
console.log(`==> wrote ${path.join(out, 'latest.json')}`);
NODE

declare -a REQUIRED_PLATFORMS=()
for target in $FLOWIX_TARGETS; do
  REQUIRED_PLATFORMS+=("$(platform_for_target "$target")")
done
node "$REPO_ROOT/scripts/verify-updater-release.mjs" \
  "$RELEASE_OUT/latest.json" "$VERSION" "$FLOWIX_R2_PREFIX" "${REQUIRED_PLATFORMS[@]}"

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
home_manifest="$FLOWIX_HOME_DIR/src/latest.json"
home_manifest_backup="$(mktemp)"
home_manifest_existed=0
if [[ -f "$home_manifest" ]]; then
  cp "$home_manifest" "$home_manifest_backup"
  home_manifest_existed=1
fi
restore_home_manifest() {
  if [[ "$home_manifest_existed" == "1" ]]; then
    cp "$home_manifest_backup" "$home_manifest"
  else
    rm -f "$home_manifest"
  fi
  rm -f "$home_manifest_backup"
}
trap restore_home_manifest EXIT
cp "$RELEASE_OUT/latest.json" "$home_manifest"
npm --prefix "$FLOWIX_HOME_DIR" run build
echo "==> deploying flowix-home"
"$WRANGLER" pages deploy "$FLOWIX_HOME_DIR/_site" \
  --project-name "$FLOWIX_HOME_PROJECT" --branch "$FLOWIX_HOME_BRANCH"

echo "==> published Flowix ${VERSION}"
echo "    manifest: $FLOWIX_UPDATER_ENDPOINT"
echo "    artifacts: $FLOWIX_R2_PUBLIC_BASE/$FLOWIX_R2_PREFIX/"
