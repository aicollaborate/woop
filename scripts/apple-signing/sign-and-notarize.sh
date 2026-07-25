#!/usr/bin/env bash
# Full Apple Developer ID signing + notarization pipeline for Flowix.
#
# Pre-requisites on the machine running this script:
#   • The Developer ID Application identity is in the login Keychain
#     (verify with:   security find-identity -v -p codesigning  )
#   • An Apple App-Specific Password has been generated from appleid.apple.com
#     and is supplied via $APPLE_APP_SPECIFIC_PASSWORD below
#
# Required env vars (none of these should ever be inlined into the script):
#   APPLE_SIGNING_IDENTITY          e.g. "Developer ID Application: Your Name (ABCDE12345)"
#                                   (output of `security find-identity -v -p codesigning`)
#   APPLE_TEAM_ID                   10-character Team ID from Membership Details
#   APPLE_ID                        Apple Account email
#
# Notarization auth - EXACTLY ONE of these two:
#   APPLE_KEYCHAIN_PROFILE          (preferred) Profile name previously stored via
#                                   `xcrun notarytool store-credentials <name> ...`
#                                   Password lives only in macOS Keychain.
#   APPLE_APP_SPECIFIC_PASSWORD     (fallback) 16-char App-Specific Password (NOT Apple ID password).
#                                   Use this if you don't have store-credentials set up.
#
# Optional env vars:
#   SKIP_BUILD=1                    Skip `tauri build`, use existing target/
#   SKIP_NOTARIZE=1                 Build + sign only, don't submit to notary
#   DMG_PATH                        (ignored in dual-target mode) override a single .dmg
#
# macOS 发版走方案 B: aarch64 + x86_64 两个 target 各出一个 DMG, 各自签名 + notarize。
# build 由 build-tauri-production.mjs 循环两个 --target 完成, 本脚本对每个 target 的
# bundle 走 resign CLI sidecar -> re-seal .app -> notarize -> staple。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/app/flowix-desktop"
ENTITLEMENTS="$DESKTOP_DIR/entitlements.plist"

# CARGO_TARGET_DIR is exported by scripts/build-cli.sh - usually
# $REPO_ROOT/.build/cargo-target. Tauri's bundle output goes there, NOT
# under app/flowix-desktop/target/release.
# `tauri build --target <triple>` 把 bundle 落到 $CARGO_TARGET_DIR/<triple>/release/bundle/,
# 跟 host 路径 ($CARGO_TARGET_DIR/release/bundle/) 分开, 两个 target 互不覆盖。
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
MACOS_TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)

# ---- 0. Validate inputs ----
: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY not set - run \`security find-identity -v -p codesigning\` and copy the full string}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set - find in developer.apple.com -> Membership Details}"
: "${APPLE_ID:?APPLE_ID not set - your Apple Developer Account email}"

# Notarization auth: pick one of two paths
if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  echo "ERROR: Set EITHER APPLE_KEYCHAIN_PROFILE OR APPLE_APP_SPECIFIC_PASSWORD, not both." >&2
  exit 2
fi
if [ -z "${APPLE_KEYCHAIN_PROFILE:-}" ] && [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  echo "ERROR: Notarization auth not configured. Choose ONE of:" >&2
  echo "  (preferred)  export APPLE_KEYCHAIN_PROFILE='name'" >&2
  echo "               (run once: xcrun notarytool store-credentials NAME --apple-id ... --team-id ... --password ...)" >&2
  echo "  (fallback)   export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'" >&2
  exit 2
fi

# Build the auth flag array used by `xcrun notarytool submit`
if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  NOTARY_AUTH_FLAGS=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
  echo "==> Notarization auth: Keychain profile '$APPLE_KEYCHAIN_PROFILE' (password NEVER in env)"
else
  NOTARY_AUTH_FLAGS=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD")
  echo "==> Notarization auth: App-Specific Password fallback (password in env)"
fi

# Friendly Team ID sanity check
if [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "ERROR: APPLE_TEAM_ID should be 10 alphanumeric characters, got: $APPLE_TEAM_ID" >&2
  exit 2
fi

# Verify the identity actually exists in the keychain before doing anything
# destructive (codesigning a half-broken build is the worst kind of waste)
if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "ERROR: '$APPLE_SIGNING_IDENTITY' is not in the codesigning identity list." >&2
  echo "       Run \`security find-identity -v -p codesigning\` and pick the right one." >&2
  exit 1
fi

if [ ! -f "$ENTITLEMENTS" ]; then
  echo "ERROR: $ENTITLEMENTS missing - the project no longer matches the docs." >&2
  exit 1
fi

cd "$REPO_ROOT"

# ---- 1. Build ----
if [ -z "${SKIP_BUILD:-}" ]; then
  echo "==> [build] Building Flowix.app + Flowix.dmg for ${MACOS_TARGETS[*]} (3-6 min/target)"
  echo "         (build-tauri-production.mjs loops both --target, signs automatically per tauri.conf.production.json)"
  if [ ! -d node_modules ]; then
    npm ci --no-audit --no-fund
  fi
  npm run tauri:build:production
else
  echo "==> [build] Skipping build (SKIP_BUILD=1)"
fi

# ---- 2-4. Per-target: re-sign CLI sidecar + re-seal .app, notarize + staple ----
# 方案 B: macOS 出 ARM + Intel 两个独立 DMG, 每个 target 各走一遍签名 + notarize。
# Tauri signs the .app contents, but the embedded `flowix-cli` sidecar needs
# a separate pass so its code signature is consistent with the outer bundle
# (otherwise Gatekeeper's nested-validation check on the inner binary can
# trip over an ad-hoc-only signature).
if [ -n "${DMG_PATH:-}" ]; then
  echo "WARN: DMG_PATH is set but dual-target mode signs both aarch64 + x64; DMG_PATH ignored." >&2
fi

sign_and_notarize_target() {
  local triple="$1"
  local bundle_macos="$CARGO_TARGET_DIR/$triple/release/bundle/macos"
  local bundle_dmg="$CARGO_TARGET_DIR/$triple/release/bundle/dmg"

  echo
  echo ":::::::::::::::::::::::::::::::::::::::::::::::::::::::::"
  echo "  Target: $triple"
  echo ":::::::::::::::::::::::::::::::::::::::::::::::::::::::::"

  local app_bundle
  app_bundle="$(find "$bundle_macos" -maxdepth 1 -type d -name "*.app" 2>/dev/null | head -1 || true)"
  if [ -z "$app_bundle" ]; then
    echo "ERROR: built .app bundle not found under $bundle_macos" >&2
    echo "       (CARGO_TARGET_DIR=${CARGO_TARGET_DIR})" >&2
    exit 1
  fi

  local cli_binary="$app_bundle/Contents/MacOS/flowix-cli"
  if [ -f "$cli_binary" ]; then
    echo "==> Re-signing CLI sidecar: $cli_binary"
    codesign --force --options runtime \
      --sign "$APPLE_SIGNING_IDENTITY" \
      --entitlements "$ENTITLEMENTS" \
      "$cli_binary"
    # Re-seal the outer bundle after touching the inner binary
    codesign --force --options runtime \
      --sign "$APPLE_SIGNING_IDENTITY" \
      --entitlements "$ENTITLEMENTS" \
      "$app_bundle"
  else
    echo "==> No flowix-cli sidecar at $cli_binary - skipping (build may have changed layout)"
  fi

  # Locate the .dmg (newest in this target's dmg dir)
  local dmg
  dmg="$(ls -t "$bundle_dmg/"*.dmg 2>/dev/null | head -1 || true)"
  if [ -z "$dmg" ] || [ ! -f "$dmg" ]; then
    echo "ERROR: .dmg not found under $bundle_dmg for $triple." >&2
    echo "       Run a full tauri:build:production first." >&2
    exit 1
  fi

  if [ -z "${SKIP_NOTARIZE:-}" ]; then
    echo "==> Submitting $dmg to Apple notary (can take 1-5 min)"
    xcrun notarytool submit "$dmg" "${NOTARY_AUTH_FLAGS[@]}" --wait

    echo "==> Stapling notarization ticket back onto the .dmg"
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"
  else
    echo "==> Skipping notarization + stapling (SKIP_NOTARIZE=1)"
  fi

  SIGNED_DMGS+=("$dmg")

  echo
  echo "  DMG ($triple): $dmg"
  echo "  SHA-256:"
  shasum -a 256 "$dmg" | awk '{print "    " $1}'
}

SIGNED_DMGS=()
for triple in "${MACOS_TARGETS[@]}"; do
  sign_and_notarize_target "$triple"
done

# ---- Done ----
echo
echo "================================================="
echo "  Notarized DMGs ready (${#SIGNED_DMGS[@]} targets):"
for dmg in "${SIGNED_DMGS[@]}"; do
  echo "    $dmg"
done
echo
echo "  SHA-256 (paste into release notes so users can verify):"
for dmg in "${SIGNED_DMGS[@]}"; do
  shasum -a 256 "$dmg" | awk -v d="$dmg" '{print "    " $1 "  " d}'
done
echo "================================================="
