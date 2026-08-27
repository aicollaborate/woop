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
#   FLOWIX_R2_PREFIX         object prefix for versioned artifacts (default: v${VERSION})
#   FLOWIX_R2_UPDATER_PREFIX object prefix for stable per-platform updater manifests
#                            (default: updater) ── written to
#                            ${BUCKET}/${PREFIX}/{macos,windows,linux}/latest.json
#   FLOWIX_R2_PUBLIC_BASE    public package origin
#   FLOWIX_UPDATER_ENDPOINT          legacy combined-manifest URL (only published on full releases)
#   FLOWIX_UPDATER_ENDPOINT_MACOS    macOS per-platform updater URL (default: https://download.flowix-memo.com/updater/macos/latest.json)
#   FLOWIX_UPDATER_ENDPOINT_WINDOWS  Windows per-platform updater URL (default: https://download.flowix-memo.com/updater/windows/latest.json)
#   FLOWIX_UPDATER_ENDPOINT_LINUX    Linux per-platform updater URL (default: https://download.flowix-memo.com/updater/linux/latest.json)
#   FLOWIX_SKIP_BUILD=1       collect artifacts already present in CARGO_TARGET_DIR
#   FLOWIX_PUBLISH=1          upload R2 + deploy flowix-home (works for both full and partial releases)
#   FLOWIX_MIGRATE_LEGACY=1   (partial releases) also advance the legacy root
#                             /latest.json to this release — the one-shot bridge
#                             that moves pre-endpoint-split clients onto the
#                             per-platform manifests. Set it on the first build
#                             that carries the per-platform endpoint, then stop.
#
# This is the only production publication path for the Flowix updater. The
# GitHub release workflow creates draft artifacts but does not update the
# configured updater endpoint. The default mode here is build + manifest
# generation only; publishing is explicit so a local build cannot accidentally
# replace the production manifest.
#
# Release scope (auto-detected from FLOWIX_TARGETS):
#   * full   = all three platform groups (macos, windows, linux) are covered
#              → per-platform updater manifests uploaded AND combined site
#                manifest written to flowix-home/src/latest.json.
#   * partial = one or two platform groups only
#              → only the covered per-platform updater manifests are
#                uploaded; flowix-home is left alone (lagging platforms keep
#                whatever the site already shows, which is correct because
#                they were not released this time).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
export CARGO_TARGET_DIR

VERSION="$(awk -F'"' '/^version *=/{print $2; exit}' "$REPO_ROOT/app/Cargo.toml")"
FLOWIX_HOME_DIR="${FLOWIX_HOME_DIR:-$REPO_ROOT/../flowix-home}"
FLOWIX_R2_BUCKET="${FLOWIX_R2_BUCKET:-flowix-downloads}"
FLOWIX_R2_PREFIX="${FLOWIX_R2_PREFIX:-v${VERSION}}"
FLOWIX_R2_UPDATER_PREFIX="${FLOWIX_R2_UPDATER_PREFIX:-updater}"
FLOWIX_R2_PUBLIC_BASE="${FLOWIX_R2_PUBLIC_BASE:-https://download.flowix-memo.com}"
FLOWIX_UPDATER_ENDPOINT="${FLOWIX_UPDATER_ENDPOINT:-https://flowix-memo.com/latest.json}"
FLOWIX_UPDATER_ENDPOINT_MACOS="${FLOWIX_UPDATER_ENDPOINT_MACOS:-https://download.flowix-memo.com/updater/macos/latest.json}"
FLOWIX_UPDATER_ENDPOINT_WINDOWS="${FLOWIX_UPDATER_ENDPOINT_WINDOWS:-https://download.flowix-memo.com/updater/windows/latest.json}"
FLOWIX_UPDATER_ENDPOINT_LINUX="${FLOWIX_UPDATER_ENDPOINT_LINUX:-https://download.flowix-memo.com/updater/linux/latest.json}"
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
    echo "release.sh: production publishing requires FLOWIX_SKIP_BUILD=1" >&2
    exit 1
  fi
  # Per-platform updater manifests make partial releases safe: mac and win
  # can now ship different latest versions on independent cadences. Full
  # releases (all three platform groups covered) still emit a combined site
  # manifest for flowix-home; partial releases skip that step on purpose.
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

# Per-release-group 名: macos/windows/linux ── 用于拆 manifest 与 R2 路径。
# 每个 group 的 manifest 互相独立, 允许 mac/win 在不同版本独立发布。
platform_group_for_target() {
  case "$1" in
    *apple-darwin) echo "macos" ;;
    *windows-msvc) echo "windows" ;;
    *linux-gnu) echo "linux" ;;
    *) echo "" ;;
  esac
}

# Default updater endpoint per group ── 用 FLOWIX_UPDATER_ENDPOINT_<GROUP>
# 可覆盖。返回空字符串表示该 group 没有 manifest (没产出)。
updater_endpoint_for_group() {
  case "$1" in
    macos)   echo "${FLOWIX_UPDATER_ENDPOINT_MACOS:-}" ;;
    windows) echo "${FLOWIX_UPDATER_ENDPOINT_WINDOWS:-}" ;;
    linux)   echo "${FLOWIX_UPDATER_ENDPOINT_LINUX:-}" ;;
    *)       echo "" ;;
  esac
}

# 写出单个 manifest (per-group 或 combined)。rows 是 "platform|name" 字符串数组。
# with_laggards=1 时会从 $FLOWIX_HOME_DIR/src/latest.json 结转 x-flowix-installers,
# 仅 combined manifest 需要这个行为 (per-group manifest 不结转)。
write_manifest() {
  local output="$1"
  local with_laggards="$2"
  shift 2
  local rows=("$@")

  FLOWIX_MANIFEST_OUT="$output" \
  FLOWIX_RELEASE_OUT="$RELEASE_OUT" \
  FLOWIX_VERSION="$VERSION" \
  FLOWIX_R2_PUBLIC_BASE="$FLOWIX_R2_PUBLIC_BASE" \
  FLOWIX_R2_PREFIX="$FLOWIX_R2_PREFIX" \
  FLOWIX_HOME_DIR="$([ "$with_laggards" = "1" ] && echo "$FLOWIX_HOME_DIR" || echo "")" \
  node "$REPO_ROOT/scripts/build-updater-manifest.mjs" "${rows[@]}"
}

# 用 verify-updater-release.mjs 校验单个 manifest。
verify_manifest() {
  local manifest="$1"
  shift
  local required_platforms=("$@")
  node "$REPO_ROOT/scripts/verify-updater-release.mjs" \
    --release-dir "$RELEASE_OUT" \
    "$manifest" "$VERSION" "$FLOWIX_R2_PREFIX" "${required_platforms[@]}"
}

append_group_row() {
  # Uppercase the group name so callers can pass either "macos" or "MACOS".
  # append_group_row macos -> GROUP_ROWS_MACOS (bash 3.2 兼容).
  local group row platform; group="$(echo "$1" | tr "[:lower:]" "[:upper:]")"; row="$2"; platform="$3"
  case "$group" in
    MACOS)
      GROUP_ROWS_MACOS+="$row"$'\n'
      GROUP_PLATFORMS_MACOS+="$platform "
      ;;
    WINDOWS)
      GROUP_ROWS_WINDOWS+="$row"$'\n'
      GROUP_PLATFORMS_WINDOWS+="$platform "
      ;;
    LINUX)
      GROUP_ROWS_LINUX+="$row"$'\n'
      GROUP_PLATFORMS_LINUX+="$platform "
      ;;
  esac
}

group_rows_var()    { echo "GROUP_ROWS_$(echo "$1" | tr "[:lower:]" "[:upper:]")"; }
group_platforms_var(){ echo "GROUP_PLATFORMS_$(echo "$1" | tr "[:lower:]" "[:upper:]")"; }
# bash 3.2 的间接引用: ${!name} 其中 name 持有变量名。不走 eval ── 既有内容
# (含换行) 原样透传, 也不存在注入面。白名单限定只读 group 变量。
group_value() {
  local name="$1"
  case "$name" in
    GROUP_ROWS_MACOS|GROUP_ROWS_WINDOWS|GROUP_ROWS_LINUX|\
    GROUP_PLATFORMS_MACOS|GROUP_PLATFORMS_WINDOWS|GROUP_PLATFORMS_LINUX)
      printf '%s' "${!name}"
      ;;
    *)
      printf '%s' ''
      ;;
  esac
}
# has_rows 放在 group_value 之后定义, 但调用是 lazy 的 ── 运行到时已经定义。
group_has_rows()    { [[ -n "$(group_value "$1")" ]]; }

declare -a MANIFEST_ROWS=()
# Per-group staging (保持 bash 3.2 兼容 ── 用 plain 变量, 不用 declare -A)。
# 每个 group 的 rows 串成 "$platform|$name\n..."; platforms 是空格分隔。
GROUP_ROWS_MACOS=""
GROUP_ROWS_WINDOWS=""
GROUP_ROWS_LINUX=""
GROUP_PLATFORMS_MACOS=""
GROUP_PLATFORMS_WINDOWS=""
GROUP_PLATFORMS_LINUX=""
for target in $FLOWIX_TARGETS; do
  platform="$(platform_for_target "$target")"
  group="$(platform_group_for_target "$target")"
  suffix="$(artifact_suffix_for_target "$target")"
  [[ -n "$platform" && -n "$group" && -n "$suffix" ]] || {
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
  append_group_row "$group" "$platform|$output_name" "$platform"
done

export FLOWIX_RELEASE_OUT="$RELEASE_OUT"
export FLOWIX_VERSION="$VERSION"
export FLOWIX_R2_PUBLIC_BASE
export FLOWIX_R2_PREFIX
export FLOWIX_HOME_DIR

# 收集有产出的 group (顺序固定为 macos -> windows -> linux, 方便日志比对)
declare -a ACTIVE_GROUPS=()
for group in macos windows linux; do
  if group_has_rows "$(group_rows_var "$group")"; then
    ACTIVE_GROUPS+=("$group")
  fi
done
IS_FULL_RELEASE=0
if [[ ${#ACTIVE_GROUPS[@]} -eq 3 ]]; then
  IS_FULL_RELEASE=1
fi
if [[ $IS_FULL_RELEASE -eq 1 ]]; then
  echo "==> release scope: full (all three platform groups covered)"
else
  echo "==> release scope: partial (only: ${ACTIVE_GROUPS[*]})"
fi

# 写出每个 group 自己的 updater manifest (供 app 内 updater 直连)。
# 不结转滞后平台 ── 该 platform 这次没产出, manifest 里就不该有它的 key,
# 否则 Tauri updater 会以为它存在并比 version, 触发「无限重装」的老 bug。
for group in "${ACTIVE_GROUPS[@]}"; do
  group_rows=()
  while IFS= read -r row; do
    [[ -n "$row" ]] && group_rows+=("$row")
  done <<< "$(group_value "$(group_rows_var "$group")")"

  group_out="$RELEASE_OUT/updater/$group/latest.json"
  mkdir -p "$(dirname "$group_out")"
  write_manifest "$group_out" 0 "${group_rows[@]}"

  read -r -a group_required <<< "$(group_value "$(group_platforms_var "$group")")"
  verify_manifest "$group_out" "${group_required[@]}"
done

# Combined site manifest: 仅全平台发布时生成并部署。partial release 跳过 ──
# 此时 combined manifest 里的 `version` 与 `platforms` 不能准确反映所有平台,
# 让 flowix-home 留着上一版就好, 滞后平台继续指向它们上次发布的产物。
COMBINED_MANIFEST=""
if [[ $IS_FULL_RELEASE -eq 1 ]]; then
  COMBINED_MANIFEST="$RELEASE_OUT/site-latest.json"
  write_manifest "$COMBINED_MANIFEST" 1 "${MANIFEST_ROWS[@]}"
  declare -a ALL_PLATFORMS=()
  for target in $FLOWIX_TARGETS; do
    ALL_PLATFORMS+=("$(platform_for_target "$target")")
  done
  verify_manifest "$COMBINED_MANIFEST" "${ALL_PLATFORMS[@]}"
fi

if [[ "${FLOWIX_PUBLISH:-0}" != "1" ]]; then
  echo "==> publish skipped (set FLOWIX_PUBLISH=1 to upload R2 and deploy flowix-home)"
  exit 0
fi

WRANGLER="${WRANGLER:-$(command -v wrangler || true)}"
if [[ -z "$WRANGLER" ]]; then
  echo "release.sh: wrangler is required when FLOWIX_PUBLISH=1" >&2
  exit 1
fi

# Per-group updater manifest 上传到稳定路径 (新 binary 直连这里 ── 不带版本号,
# 每次发布会 OVERWRITE)。这条路径不受 partial release 影响, 总是跑。
for group in "${ACTIVE_GROUPS[@]}"; do
  group_manifest="$RELEASE_OUT/updater/$group/latest.json"
  echo "==> uploading $group updater manifest to R2"
  "$WRANGLER" r2 object put "$FLOWIX_R2_BUCKET/$FLOWIX_R2_UPDATER_PREFIX/$group/latest.json" \
    --file "$group_manifest" --remote
done

# Versioned artifacts 上传到版本前缀路径 (immutable)。现有逻辑保持不变。
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

# flowix-home (官网下载页) 部署。
# * full release: 用 combined manifest 整体覆盖 (存量客户端的 legacy updater
#   语义 + 官网 x-flowix-installers 一起刷新)。
# * partial release: 只把本次发布的 group 的 x-flowix-installers 条目合并进
#   官网 manifest ── version/platforms 一字不动 (那是存量客户端的 updater
#   语义, 只能在 full release 重生成), 但官网弹窗立即显示新版本与下载链接。
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

if [[ $IS_FULL_RELEASE -eq 1 ]]; then
  echo "==> flowix-home: full release (combined site manifest)"
  cp "$COMBINED_MANIFEST" "$home_manifest"
else
  echo "==> flowix-home: merging shipped installer entries into site manifest"
  ACTIVE_GROUPS_STR="${ACTIVE_GROUPS[*]}" \
  FLOWIX_HOME_MANIFEST="$home_manifest" \
  FLOWIX_RELEASE_OUT="$RELEASE_OUT" \
  node "$REPO_ROOT/scripts/merge-site-installers.mjs"
fi
npm --prefix "$FLOWIX_HOME_DIR" run build
echo "==> deploying flowix-home"
"$WRANGLER" pages deploy "$FLOWIX_HOME_DIR/_site" \
  --project-name "$FLOWIX_HOME_PROJECT" --branch "$FLOWIX_HOME_BRANCH"

echo "==> published Flowix ${VERSION}"
for group in "${ACTIVE_GROUPS[@]}"; do
  echo "    updater[$group]: $(updater_endpoint_for_group "$group")"
done
if [[ $IS_FULL_RELEASE -eq 1 ]]; then
  echo "    site manifest: $FLOWIX_UPDATER_ENDPOINT"
fi
echo "    artifacts: $FLOWIX_R2_PUBLIC_BASE/$FLOWIX_R2_PREFIX/"
