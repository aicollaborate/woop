#!/usr/bin/env bash
# mobile-dev.sh — 在 desktop + mobile 共存的 monorepo 里启动 iOS dev。
#
# 根因：tauri-cli 2.11.x 的 app_paths 从 .git 根 walk 子目录找 tauri.conf.json，
# 按字母序 flowix-desktop 先于 flowix-mobile 命中，导致 `tauri ios dev` 的
# xcode-script 子命令把构建目标错路由到 desktop。上游 2.11.3/2.11.4 未修。
#
# 解法（J）：跑 mobile dev 期间临时移走 desktop/tauri.conf.json，让 walk 落到
# mobile；退出时（含 Ctrl+C / 异常）靠 trap 自动恢复，避免 desktop 链路被破坏。
set -uo pipefail

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 切到 repo root（scripts/ 上一级）
cd "$(dirname "$0")/.."

# 强制 cargo 用 .build/cargo-target（与 app/.cargo/config.toml 一致）。
# 否则 tauri-cli 的 cargo metadata 读到 config 报告 .build/cargo-target，
# 但 xcode-script 跑的 cargo build cwd 在 gen/apple 树下读不到该 config，
# 退回默认 app/target，导致 tauri-cli 找不到 libflowix_mobile.a。
export CARGO_TARGET_DIR="$PWD/.build/cargo-target"

# swift-rs（Tauri iOS 构建依赖）的 build.rs 要 git clone github.com/Brendonovich/swift-rs
# 编译 Swift package。本机 git HTTP/2 间歇性 "HTTP2 framing layer" 失败，强制 HTTP/1.1 规避。
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.version"
export GIT_CONFIG_VALUE_0="HTTP/1.1"

CONF="app/flowix-desktop/tauri.conf.json"
DEVICE="${1:-iPhone 17 Pro}"

# 残留检测：上次异常退出未恢复则拒绝启动，避免二次 mv 覆盖丢 conf
if [[ -f "$CONF.bak" ]]; then
  echo "ERROR: $CONF.bak 已存在，上次 mobile-dev 异常退出未恢复。" >&2
  echo "  若 $CONF 仍在: rm \"$CONF.bak\"" >&2
  echo "  若 $CONF 已被移走: mv \"$CONF.bak\" \"$CONF\"" >&2
  exit 1
fi

trap 'mv -f "$CONF.bak" "$CONF" 2>/dev/null || true' EXIT INT TERM

mv "$CONF" "$CONF.bak"
echo "[mobile-dev] 临时移走 $CONF -> .bak，退出时自动恢复"
echo "[mobile-dev] device: $DEVICE"

npm run tauri:ios:dev -- "$DEVICE"
