#!/usr/bin/env bash
# Build flowix-cli (the standalone CLI sidecar) and copy the binary into
# `app/flowix-desktop/binaries/` so Tauri's externalBin can pick it up.
#
# Usage:
#   bash scripts/build-cli.sh              # release build, current host
#   bash scripts/build-cli.sh --debug      # debug build, current host
#   bash scripts/build-cli.sh --all        # build all 3 host triples into binaries/
#   bash scripts/build-cli.sh --macos      # macOS only: aarch64 (本地 darwin 发版)
#
# Side-effect:
# - writes `app/flowix-desktop/binaries/flowix-cli-<host-triple>` (with the right
#   extension on Windows, but Tauri will rename it on copy).
# - does NOT touch the workspace `target/` (cargo decides where to put it).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../app" && pwd)"
BINARIES_DIR="$APP_DIR/flowix-desktop/binaries"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
export CARGO_TARGET_DIR

PROFILE="release"
# BUILD_MODE: host (单当前 host) | all (CI 三平台四 triple) | macos (macOS arm64 + Intel)
BUILD_MODE="host"

for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE="debug" ;;
    --all)   BUILD_MODE="all" ;;
    --macos) BUILD_MODE="macos" ;;
    -h|--help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

# --debug + 多 triple 是矛盾的: 多 triple 链路强制 release, --debug 期望 debug 产物。
# 显式拒绝, 避免调用者拿到一个跟意图不符的 binary。
if [ "$BUILD_MODE" != "host" ] && [ "$PROFILE" = "debug" ]; then
  echo "error: --debug and --$BUILD_MODE are mutually exclusive (--$BUILD_MODE pins release)" >&2
  exit 2
fi

# ── helpers ──────────────────────────────────────────────────────────
host_triple() {
  rustc -vV | sed -n 's|host: ||p'
}

# Tauri externalBin 期待: binaries/flowix-cli (无后缀)。 Windows 上仍用
# 同名 (Tauri 内部加 .exe), Unix 也不加后缀。
copy_to_binaries() {
  local host="$1"
  local src="$2"
  local ext=""
  if [[ "$host" == *windows* ]]; then
    ext=".exe"
  fi
  local dst="$BINARIES_DIR/flowix-cli-$host$ext"
  mkdir -p "$BINARIES_DIR"
  if [[ "$host" == *windows* ]]; then
    cp "$src" "$dst"
  else
    # Do not inherit a stale/non-executable mode from an incremental Cargo
    # output. Tauri preserves the sidecar mode when it creates the app bundle,
    # so a missing execute bit here produces a permanently broken CLI in the
    # final DMG.
    install -m 0755 "$src" "$dst"
    if [[ "$host" == *apple* ]]; then
      # Locally built files can inherit quarantine from a checkout downloaded
      # as an archive. This staging binary is freshly compiled from the trusted
      # checkout; leaving the inherited attribute in place makes Gatekeeper
      # assess the un-notarized staging file instead of the final notarized DMG.
      xattr -d com.apple.quarantine "$dst" 2>/dev/null || true
    fi
    if [ ! -x "$dst" ]; then
      echo "error: CLI sidecar is not executable after install: $dst" >&2
      exit 1
    fi
  fi
  echo "  -> $dst"
}

# Dev-mode 入口: `binaries/flowix-cli` (无 triple / 扩展名) 是 Tauri 2 在
# `cargo tauri dev` 时的 sidecar 源文件名 (没有就走 fallback 失败)。
# 这里在 `binaries/flowix-cli-<host>` 旁建一个同名 symlink 指向它 ──
# 只在单 host build 时跑, 多 triple 模式 symlink 没法统一指向。
#
# Windows 上 Git Bash 在没开 Developer Mode 时建不出 symlink; 失败就
# 退化成 cp -f。 dev 本地完全够用, 只是 dev 期改 src 后 CLI sidecar
# 跟大 binary 同步更新反而更可控 (不会出现 symlink 指向陈旧 target 的
# 视觉残留)。
create_dev_symlink() {
  local host="$1"
  local ext=""
  if [[ "$host" == *windows* ]]; then
    ext=".exe"
  fi
  local target="flowix-cli-$host$ext"
  local link="$BINARIES_DIR/flowix-cli"
  [[ -n "$ext" ]] && link="${link}${ext}"
  # 旧的 symlink / 文件残留先清掉, ln -sf 跨平台会覆盖, 这里显式 rm 防止奇怪状态。
  rm -f "$link"
  if ln -s "$target" "$link" 2>/dev/null; then
    echo "  -> dev symlink: $link -> $target"
  else
    cp -f "$BINARIES_DIR/$target" "$link"
    echo "  -> dev copy (symlink unavailable): $link"
  fi
}

# ── main ────────────────────────────────────────────────────────────
echo "▸ flowix-cli build (profile=$PROFILE, mode=$BUILD_MODE)"

# 按 mode 决定要编哪些 triple。多 triple 走统一循环, host 模式走单 host 分支。
case "$BUILD_MODE" in
  all)
    # CI 用 ── 三平台四 triple 全编。
    TRIPLES=(x86_64-unknown-linux-gnu x86_64-apple-darwin aarch64-apple-darwin x86_64-pc-windows-msvc)
    ;;
  macos)
    # 本地 darwin 发版 ── 编译两个 macOS 架构，不碰 linux/windows
    # (macOS 本地缺 linux/windows cross toolchain, --all 会挂)。
    TRIPLES=(aarch64-apple-darwin x86_64-apple-darwin)
    ;;
  host)
    TRIPLES=()
    ;;
esac

if [ ${#TRIPLES[@]} -gt 0 ]; then
  for triple in "${TRIPLES[@]}"; do
    echo "▸ build for $triple"
    cargo build \
      --manifest-path "$APP_DIR/Cargo.toml" \
      --bin flowix-cli \
      --target "$triple" \
      --release
    bin_path="$CARGO_TARGET_DIR/$triple/release/flowix-cli"
    [[ "$triple" == *windows* ]] && bin_path="${bin_path}.exe"
    copy_to_binaries "$triple" "$bin_path"
    # 签名 ── macOS / Windows 走 codesign / signtool, Linux 跳过。
    # sign-cli.sh 自己负责无证书开发环境的显式 skip；真正的签名错误
    # 必须终止构建，不能把坏 sidecar 带进正式安装包。
    bash "$SCRIPT_DIR/sign-cli.sh" --host="$triple"
  done
else
  host="$(host_triple)"
  echo "▸ host = $host"
  cargo build \
    --manifest-path "$APP_DIR/Cargo.toml" \
    --bin flowix-cli \
    $([ "$PROFILE" = "release" ] && echo "--release")
  bin_path="$CARGO_TARGET_DIR/$PROFILE/flowix-cli"
  if [ ! -f "$bin_path" ]; then
    # If callers override CARGO_TARGET_DIR or Cargo uses host-specific output,
    # keep a fallback that mirrors explicit --target builds.
    bin_path="$CARGO_TARGET_DIR/$host/$PROFILE/flowix-cli"
  fi
  copy_to_binaries "$host" "$bin_path"
  bash "$SCRIPT_DIR/sign-cli.sh" --host="$host"
fi

# Dev-mode symlink: 让 `cargo tauri dev` 能找到 `binaries/flowix-cli`。
# 多 triple 模式 (all / macos) 跳过 ── 跨 triple symlink 指向哪个都歧义,
# 只在单 host build 时建, dev 本地用。
if [ "$BUILD_MODE" = "host" ]; then
  create_dev_symlink "$host"
else
  echo "  (skip dev symlink in $BUILD_MODE mode)"
fi

echo "✓ done"
