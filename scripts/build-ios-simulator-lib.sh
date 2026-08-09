#!/usr/bin/env bash
# Build the Rust static library that Tauri's generated iOS project links.
# The project's pre-build Rust hook is intentionally removed by
# patch-ios-native.mjs, so without this step `tauri ios dev` can reuse an old
# gen/apple/Externals/arm64/debug/libapp.a.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
mobile_dir="$repo_root/app/flowix-mobile"
target_dir="$repo_root/.build/cargo-target"
target="aarch64-apple-ios-sim"
minimum_ios_version="$(node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync("app/flowix-mobile/tauri.ios.conf.json", "utf8")); console.log(config.bundle.iOS.minimumSystemVersion)')"
cargo_library="$target_dir/$target/debug/libflowix_mobile.a"
xcode_library="$mobile_dir/gen/apple/Externals/arm64/debug/libapp.a"

(
  cd "$mobile_dir"
  IPHONEOS_DEPLOYMENT_TARGET="$minimum_ios_version" \
  CARGO_TARGET_DIR="$target_dir" cargo rustc --lib --target "$target" --crate-type staticlib
)

mkdir -p "$(dirname "$xcode_library")"
cp "$cargo_library" "$xcode_library"
