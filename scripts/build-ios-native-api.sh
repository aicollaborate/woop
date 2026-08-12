#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
target_dir="$repo_root/.build/cargo-target"
output_dir="$repo_root/.build/native-api"

for target in aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-ios; do
  (
    cd "$repo_root/app"
    IPHONEOS_DEPLOYMENT_TARGET="16.2" \
      CARGO_TARGET_DIR="$target_dir" \
      cargo rustc -p flowix-native-api --lib --target "$target" --crate-type staticlib
  )
done

mkdir -p "$output_dir"
mkdir -p "$output_dir/sim" "$output_dir/device"
lipo -create \
  "$target_dir/aarch64-apple-ios-sim/debug/libflowix_native_api.a" \
  "$target_dir/x86_64-apple-ios/debug/libflowix_native_api.a" \
  -output "$output_dir/sim/libflowix_native_api.a"
cp "$target_dir/aarch64-apple-ios/debug/libflowix_native_api.a" "$output_dir/device/libflowix_native_api.a"
echo "Built native API: $output_dir/{sim,device}/libflowix_native_api.a"
