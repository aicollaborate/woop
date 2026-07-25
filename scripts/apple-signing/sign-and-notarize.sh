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
# Notarization auth — EXACTLY ONE of these two:
#   APPLE_KEYCHAIN_PROFILE          (preferred) Profile name previously stored via
#                                   `xcrun notarytool store-credentials <name> ...`
#                                   Password lives only in macOS Keychain.
#   APPLE_APP_SPECIFIC_PASSWORD     (fallback) 16-char App-Specific Password (NOT Apple ID password).
#                                   Use this if you don't have store-credentials set up.
#
# Optional env vars:
#   SKIP_BUILD=1                    Skip `tauri build`, use existing target/
#   SKIP_NOTARIZE=1                 Build + sign only, don't submit to notary
#   DMG_PATH                        Override the auto-detected .dmg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/app/flowix-desktop"
ENTITLEMENTS="$DESKTOP_DIR/entitlements.plist"

# CARGO_TARGET_DIR is exported by scripts/build-cli.sh — usually
# $REPO_ROOT/.build/cargo-target. Tauri's bundle output goes there, NOT
# under app/flowix-desktop/target/release.
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/.build/cargo-target}"
BUNDLE_MACOS="$CARGO_TARGET_DIR/release/bundle/macos"
BUNDLE_DMG="$CARGO_TARGET_DIR/release/bundle/dmg"

# ---- 0. Validate inputs ----
: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY not set — run \`security find-identity -v -p codesigning\` and copy the full string}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set — find in developer.apple.com → Membership Details}"
: "${APPLE_ID:?APPLE_ID not set — your Apple Developer Account email}"

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
  echo "ERROR: $ENTITLEMENTS missing — the project no longer matches the docs." >&2
  exit 1
fi

cd "$REPO_ROOT"

# ---- 1. Build ----
if [ -z "${SKIP_BUILD:-}" ]; then
  echo "==> [1/4] Building Flowix.app + Flowix.dmg (this can take 3-6 minutes)"
  echo "         (signs automatically per tauri.conf.production.json)"
  if [ ! -d node_modules ]; then
    npm ci --no-audit --no-fund
  fi
  npm run tauri:build:production
else
  echo "==> [1/4] Skipping build (SKIP_BUILD=1)"
fi

# ---- 2. Re-sign the CLI sidecar with the same Developer ID ----
# Tauri signs the .app contents, but the embedded `flowix-cli` sidecar needs
# a separate pass so its code signature is consistent with the outer bundle
# (otherwise Gatekeeper's nested-validation check on the inner binary can
# trip over an ad-hoc-only signature).
APP_BUNDLE="$(find "$BUNDLE_MACOS" -maxdepth 1 -type d -name "*.app" 2>/dev/null | head -1 || true)"
if [ -z "$APP_BUNDLE" ]; then
  echo "ERROR: built .app bundle not found under $BUNDLE_MACOS" >&2
  echo "       (CARGO_TARGET_DIR=${CARGO_TARGET_DIR})" >&2
  exit 1
fi

CLI_BINARY="$APP_BUNDLE/Contents/MacOS/flowix-cli"
if [ -f "$CLI_BINARY" ]; then
  echo "==> [2/4] Re-signing CLI sidecar: $CLI_BINARY"
  codesign --force --options runtime \
    --sign "$APPLE_SIGNING_IDENTITY" \
    --entitlements "$ENTITLEMENTS" \
    "$CLI_BINARY"
  # Re-seal the outer bundle after touching the inner binary
  codesign --force --options runtime \
    --sign "$APPLE_SIGNING_IDENTITY" \
    --entitlements "$ENTITLEMENTS" \
    "$APP_BUNDLE"
else
  echo "==> [2/4] No flowix-cli sidecar at $CLI_BINARY — skipping (build may have changed layout)"
fi

# ---- 3. Locate the .dmg ----
if [ -n "${DMG_PATH:-}" ]; then
  DMG="$DMG_PATH"
else
  DMG="$(ls -t "$BUNDLE_DMG/"*.dmg 2>/dev/null | head -1 || true)"
fi
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "ERROR: .dmg not found. Either set DMG_PATH or run a full tauri:build:production first." >&2
  exit 1
fi

# ---- 4. Notarize + staple ----
if [ -z "${SKIP_NOTARIZE:-}" ]; then
  echo "==> [3/4] Submitting $DMG to Apple notary (interactive-ish — can take 1-5 min)"
  xcrun notarytool submit "$DMG" "${NOTARY_AUTH_FLAGS[@]}" --wait

  echo "==> [4/4] Stapling notarization ticket back onto the .dmg"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
else
  echo "==> [3/4,4/4] Skipping notarization + stapling (SKIP_NOTARIZE=1)"
fi

# ---- Done ----
echo
echo "================================================="
echo "  Notarized DMG ready:"
echo "    $DMG"
echo
echo "  SHA-256 (paste into your release notes so users can verify):"
shasum -a 256 "$DMG" | awk '{print "    " $1}'
echo "================================================="
