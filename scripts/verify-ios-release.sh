#!/usr/bin/env bash
# Verify the exact iOS .ipa that will be uploaded to TestFlight.
#
# Mirrors scripts/verify-macos-release.sh's two-stage gate idea, but adapted
# for the iOS artifact (a zip containing Payload/<App>.app + embedded
# .mobileprovision). There is no notarization ticket to validate on iOS —
# App Store review handles that. What we DO verify:
#
#   1. The .ipa is a valid zip and contains Payload/*.app
#   2. codesign --verify on the .app passes with strict + deep
#   3. The signed bundle's TeamIdentifier matches $APPLE_TEAM_ID
#   4. The bundle's CFBundleIdentifier is "com.flowix.app.mobile"
#   5. The embedded.mobileprovision decodes, has the same TeamIdentifier,
#      names the right bundle id, and isn't expiring within 30 days
#
# Usage:
#   bash scripts/verify-ios-release.sh <path-to-ipa>
#
# Requires APPLE_TEAM_ID env var (10-char Team ID) for the team-id checks.

set -euo pipefail

IPA="${1:-}"

if [ -z "$IPA" ]; then
  echo "usage: $0 <path-to-ipa>" >&2
  exit 2
fi

if [ ! -f "$IPA" ]; then
  echo "ERROR: .ipa not found: $IPA" >&2
  exit 1
fi

if [ -z "${APPLE_TEAM_ID:-}" ]; then
  echo "ERROR: APPLE_TEAM_ID not set - required for team-identifier checks." >&2
  exit 2
fi

EXPECTED_BUNDLE_ID="com.flowix.app.mobile"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- 1. Unpack the .ipa (it's a plain ZIP) ----
unzip -q "$IPA" -d "$WORK"
APP_DIR="$(find "$WORK/Payload" -maxdepth 1 -name "*.app" | head -1)"
if [ -z "$APP_DIR" ] || [ ! -d "$APP_DIR" ]; then
  echo "ERROR: $IPA contains no Payload/*.app" >&2
  exit 1
fi
echo "==> App bundle: $APP_DIR"

# ---- 2. Codesign deep verify ----
codesign --verify --strict --verbose=2 "$APP_DIR"

# ---- 3. TeamIdentifier on the signed bundle must match ----
TEAM="$(codesign -dv --verbose=4 "$APP_DIR" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -1)"
if [ -z "$TEAM" ]; then
  echo "ERROR: signed bundle has no TeamIdentifier: $APP_DIR" >&2
  exit 1
fi
if [ "$TEAM" != "$APPLE_TEAM_ID" ]; then
  echo "ERROR: TeamIdentifier mismatch: expected $APPLE_TEAM_ID, got $TEAM" >&2
  exit 1
fi

# ---- 4. CFBundleIdentifier must be our app ----
INFO_PLIST="$APP_DIR/Info.plist"
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw "$INFO_PLIST")"
if [ "$BUNDLE_ID" != "$EXPECTED_BUNDLE_ID" ]; then
  echo "ERROR: CFBundleIdentifier mismatch: expected $EXPECTED_BUNDLE_ID, got $BUNDLE_ID" >&2
  exit 1
fi

# ---- 5. Decode embedded.mobileprovision + cross-check ----
EMB_PROVISION="$APP_DIR/embedded.mobileprovision"
if [ ! -f "$EMB_PROVISION" ]; then
  echo "ERROR: no embedded.mobileprovision in $APP_DIR" >&2
  exit 1
fi

PROVISION_PLIST="$WORK/profile.plist"
if ! security cms -D -i "$EMB_PROVISION" -o "$PROVISION_PLIST" 2>/dev/null; then
  echo "ERROR: cannot decode embedded.mobileprovision" >&2
  exit 1
fi

PROFILE_TEAM="$(plutil -extract TeamIdentifier raw "$PROVISION_PLIST")"
if [ "$PROFILE_TEAM" != "$APPLE_TEAM_ID" ]; then
  echo "ERROR: profile TeamIdentifier mismatch: expected $APPLE_TEAM_ID, got $PROFILE_TEAM" >&2
  exit 1
fi

# Profile BundleIdentifier can be either exact (e.g. "com.flowix.app.mobile")
# or wildcard ("*") for App Store distribution profiles — match either.
PROFILE_BUNDLE="$(plutil -extract BundleIdentifier raw "$PROVISION_PLIST" 2>/dev/null || echo "")"
case "$PROFILE_BUNDLE" in
  "$EXPECTED_BUNDLE_ID"|"*") ;;
  *)
    echo "ERROR: profile BundleIdentifier mismatch: expected $EXPECTED_BUNDLE_ID or '*', got '$PROFILE_BUNDLE'" >&2
    exit 1
    ;;
esac

# ---- 6. Expiration warning ----
EXP_RAW="$(plutil -extract ExpirationDate raw "$PROVISION_PLIST" 2>/dev/null || echo "")"
if [ -n "$EXP_RAW" ] && command -v gdate >/dev/null 2>&1; then
  # macOS date can't parse ISO-8601 with TZ reliably; gdate (coreutils) can
  EXP_TS="$(gdate -d "$EXP_RAW" +%s 2>/dev/null || echo 0)"
elif [ -n "$EXP_RAW" ]; then
  # BSD date on macOS: -j -f accepts ISO-8601
  EXP_TS="$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$EXP_RAW" +%s 2>/dev/null || echo 0)"
else
  EXP_TS=0
fi
if [ -n "$EXP_TS" ] && [ "$EXP_TS" -gt 0 ]; then
  NOW_TS="$(date +%s)"
  DAYS_LEFT=$(( (EXP_TS - NOW_TS) / 86400 ))
  if [ "$DAYS_LEFT" -lt 0 ]; then
    echo "ERROR: profile has EXPIRED (${EXP_RAW}); regenerate it in the Developer Portal." >&2
    exit 1
  elif [ "$DAYS_LEFT" -lt 30 ]; then
    echo "WARN: profile expires in $DAYS_LEFT days ($EXP_RAW); plan to renew." >&2
  else
    echo "==> Profile valid for $DAYS_LEFT more days (expires $EXP_RAW)"
  fi
fi

# ---- Done ----
PROFILE_NAME="$(plutil -extract Name raw "$PROVISION_PLIST" 2>/dev/null || echo "?")"
echo "==> Verified IPA:"
echo "    codesign OK"
echo "    TeamIdentifier = $TEAM"
echo "    CFBundleIdentifier = $BUNDLE_ID"
echo "    profile = $PROFILE_NAME"
