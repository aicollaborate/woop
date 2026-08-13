#!/usr/bin/env bash
# Build the native Swift iOS app, verify the IPA, and upload it to TestFlight.
#
# This is deliberately separate from build-and-upload-testflight.sh: that
# script targets the Tauri app (com.flowix.app.mobile). This script builds the
# native implementation as an update of that same App Store Connect app.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$REPO_ROOT/app/flowix-ios-native"
PROJECT="$NATIVE_DIR/FlowixIOS.xcodeproj"
SCHEME="FlowixIOS"
BUNDLE_ID="com.flowix.app.mobile"
MARKETING_VERSION="1.1.15"
VERIFY_IOS="$REPO_ROOT/scripts/verify-ios-release.sh"

# Required for a signed build. Keep these values in the environment, never in
# this script or in the repository.
if [ -z "${SKIP_BUILD:-}" ]; then
  : "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set}"
  : "${IOS_CERT_P12_PATH:?IOS_CERT_P12_PATH not set}"
  : "${IOS_CERT_P12_PASSWORD:?IOS_CERT_P12_PASSWORD not set}"
  IOS_NATIVE_MOBILE_PROVISION_PATH="${IOS_NATIVE_MOBILE_PROVISION_PATH:-${IOS_MOBILE_PROVISION_PATH:-}}"
  : "${IOS_NATIVE_MOBILE_PROVISION_PATH:?IOS_NATIVE_MOBILE_PROVISION_PATH or IOS_MOBILE_PROVISION_PATH not set}"
  export IOS_NATIVE_MOBILE_PROVISION_PATH
  for signing_file in "$IOS_CERT_P12_PATH" "$IOS_NATIVE_MOBILE_PROVISION_PATH"; do
    if [ ! -f "$signing_file" ]; then
      echo "ERROR: signing file does not exist: $signing_file" >&2
      exit 1
    fi
  done
fi

if [ ! -x "$VERIFY_IOS" ]; then
  echo "ERROR: $VERIFY_IOS is missing or not executable." >&2
  exit 1
fi

if [ -n "${APPLE_TEAM_ID:-}" ] && [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "ERROR: APPLE_TEAM_ID should be 10 alphanumeric characters." >&2
  exit 2
fi

IOS_BUILD_NUMBER="${IOS_BUILD_NUMBER:-$(date +%s)}"
if [[ ! "$IOS_BUILD_NUMBER" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "ERROR: IOS_BUILD_NUMBER must contain one to three numeric components." >&2
  exit 2
fi

UPLOAD_AUTH=""
UPLOAD_AUTH_FLAGS=()
if [ -z "${SKIP_UPLOAD:-}" ]; then
  if [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_ID:-}" ]; then
    if [ -n "${APPLE_ASC_API_KEY_ID:-}" ] || [ -n "${APPLE_ASC_API_KEY_PATH:-}" ]; then
      echo "ERROR: configure either ASC API key auth or Apple ID + app-specific password, not both." >&2
      exit 2
    fi
    UPLOAD_AUTH="app-specific-password"
    UPLOAD_AUTH_FLAGS=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD")
  elif [ -n "${APPLE_ASC_API_KEY_ID:-}" ] && [ -n "${APPLE_ASC_API_ISSUER_ID:-}" ] && [ -n "${APPLE_ASC_API_KEY_PATH:-}" ]; then
    if [[ ! "$APPLE_ASC_API_KEY_ID" =~ ^[A-Z0-9]{10}$ ]]; then
      echo "ERROR: APPLE_ASC_API_KEY_ID should be 10 uppercase alphanumeric characters." >&2
      exit 2
    fi
    if [ ! -f "$APPLE_ASC_API_KEY_PATH" ]; then
      echo "ERROR: APPLE_ASC_API_KEY_PATH does not exist: $APPLE_ASC_API_KEY_PATH" >&2
      exit 1
    fi
    UPLOAD_AUTH="asc-api-key"
    UPLOAD_AUTH_FLAGS=(--apiKey "$APPLE_ASC_API_KEY_ID" --apiIssuer "$APPLE_ASC_API_ISSUER_ID")
  else
    echo "ERROR: upload auth is not configured. Set the ASC API key triple or Apple ID + app-specific password." >&2
    exit 2
  fi
fi

cd "$REPO_ROOT"
ARCHIVE_DIR="$REPO_ROOT/.build/ios-native-archive"
EXPORT_DIR="$REPO_ROOT/.build/ios-native-export"
IPA_PATH=""
KEYCHAIN_PATH=""
KEYCHAIN_DIR=""
PROVISION_UUID=""

cleanup() {
  if [ -n "$KEYCHAIN_PATH" ]; then
    security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  fi
  if [ -n "$KEYCHAIN_DIR" ]; then
    rmdir "$KEYCHAIN_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [ -z "${SKIP_BUILD:-}" ]; then
  echo "==> [build] editor webview"
  npm run build:ios-editor
  npm run stage:ios-editor

  echo "==> [build] native Rust API"
  npm run build:ios-native-api

  PROFILES_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
  mkdir -p "$PROFILES_DIR"
  PROVISION_UUID="$(security cms -D -i "$IOS_NATIVE_MOBILE_PROVISION_PATH" 2>/dev/null | plutil -extract UUID raw - 2>/dev/null || true)"
  if [ -z "$PROVISION_UUID" ]; then
    echo "ERROR: cannot extract UUID from $IOS_NATIVE_MOBILE_PROVISION_PATH." >&2
    exit 1
  fi
  cp "$IOS_NATIVE_MOBILE_PROVISION_PATH" "$PROFILES_DIR/$PROVISION_UUID.mobileprovision"

  KEYCHAIN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flowix-ios-native-signing.XXXXXX")"
  KEYCHAIN_PATH="$KEYCHAIN_DIR/signing.keychain-db"
  echo "==> [sign] isolated keychain"
  security create-keychain -p "$IOS_CERT_P12_PASSWORD" "$KEYCHAIN_PATH"
  security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
  security unlock-keychain -p "$IOS_CERT_P12_PASSWORD" "$KEYCHAIN_PATH"
  security import "$IOS_CERT_P12_PATH" -P "$IOS_CERT_P12_PASSWORD" \
    -T /usr/bin/codesign -T /usr/bin/security -A -k "$KEYCHAIN_PATH"
  security set-key-partition-list -S apple-tool:,apple: -s \
    -k "$IOS_CERT_P12_PASSWORD" "$KEYCHAIN_PATH"

  CERT_SHA1="$(security find-certificate -a -c 'Apple Distribution' -Z "$KEYCHAIN_PATH" 2>/dev/null | awk '/SHA-1 hash/ {print $3}' | head -1)"
  if [ -z "$CERT_SHA1" ]; then
    echo "ERROR: Apple Distribution certificate not found in imported .p12." >&2
    exit 1
  fi

  rm -rf "$ARCHIVE_DIR" "$EXPORT_DIR"
  mkdir -p "$ARCHIVE_DIR" "$EXPORT_DIR"
  echo "==> [archive] $SCHEME $MARKETING_VERSION ($IOS_BUILD_NUMBER)"
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_DIR/FlowixIOS.xcarchive" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    PROVISIONING_PROFILE_SPECIFIER="$PROVISION_UUID" \
    PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
    MARKETING_VERSION="$MARKETING_VERSION" \
    CURRENT_PROJECT_VERSION="$IOS_BUILD_NUMBER" \
    archive

  APP_DIR_IN_ARCHIVE="$ARCHIVE_DIR/FlowixIOS.xcarchive/Products/Applications/Flowix.app"
  if [ ! -d "$APP_DIR_IN_ARCHIVE" ]; then
    echo "ERROR: archived app not found at $APP_DIR_IN_ARCHIVE." >&2
    exit 1
  fi
  cp "$IOS_NATIVE_MOBILE_PROVISION_PATH" "$APP_DIR_IN_ARCHIVE/embedded.mobileprovision"
  echo "==> [sign] native app"
  codesign --force --sign "$CERT_SHA1" \
    --keychain "$KEYCHAIN_PATH" \
    --entitlements "$NATIVE_DIR/FlowixIOS/Flowix.entitlements" \
    --generate-entitlement-der \
    "$APP_DIR_IN_ARCHIVE"
  codesign --verify --strict --verbose=2 "$APP_DIR_IN_ARCHIVE"

  EXPORT_PLIST="$REPO_ROOT/.build/ExportOptions-ios-native-testflight.plist"
  if [ ! -f "$EXPORT_PLIST" ]; then
    /usr/bin/touch "$EXPORT_PLIST"
  fi
  /usr/bin/plutil -create xml1 "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Clear dict" "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :method string app-store-connect" "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :teamID string $APPLE_TEAM_ID" "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :signingStyle string manual" "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :provisioningProfiles dict" "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :provisioningProfiles:$BUNDLE_ID string $PROVISION_UUID" "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :uploadSymbols bool true" "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :uploadBitcode bool false" "$EXPORT_PLIST"

  echo "==> [export] IPA"
  xcodebuild \
    -exportArchive \
    -archivePath "$ARCHIVE_DIR/FlowixIOS.xcarchive" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_PLIST"
  IPA_PATH="$(find "$EXPORT_DIR" -name '*.ipa' -type f | head -1 || true)"
else
  echo "==> [build] skipped (SKIP_BUILD=1)"
  IPA_PATH="$(find "$EXPORT_DIR" -name '*.ipa' -type f 2>/dev/null | head -1 || true)"
fi

if [ -z "$IPA_PATH" ] || [ ! -f "$IPA_PATH" ]; then
  echo "ERROR: native iOS IPA not found under $EXPORT_DIR." >&2
  exit 1
fi
echo "==> [artifact] $IPA_PATH"

if [ -z "${SKIP_VERIFY:-}" ]; then
  echo "==> [verify] native IPA"
  APPLE_TEAM_ID="${APPLE_TEAM_ID:-}" bash "$VERIFY_IOS" "$IPA_PATH" "$BUNDLE_ID"
else
  echo "==> [verify] skipped (SKIP_VERIFY=1)"
fi

if [ -z "${SKIP_UPLOAD:-}" ]; then
  XCODE_CONTENTS_DIR="$(dirname "$(xcode-select -p)")"
  ALTOOL_BIN="$XCODE_CONTENTS_DIR/SharedFrameworks/ContentDelivery.framework/Resources/altool"
  if [ ! -x "$ALTOOL_BIN" ]; then
    echo "ERROR: altool not found at $ALTOOL_BIN" >&2
    exit 1
  fi
  echo "==> [upload] TestFlight ($UPLOAD_AUTH)"
  if [ "$UPLOAD_AUTH" = "asc-api-key" ]; then
    API_PRIVATE_KEYS_DIR="$(dirname "$APPLE_ASC_API_KEY_PATH")" \
      "$ALTOOL_BIN" --upload-app --type ios \
      "${UPLOAD_AUTH_FLAGS[@]}" -f "$IPA_PATH" --output-format xml
  else
    "$ALTOOL_BIN" --upload-app --type ios \
      "${UPLOAD_AUTH_FLAGS[@]}" -f "$IPA_PATH" --output-format xml
  fi
else
  echo "==> [upload] skipped (SKIP_UPLOAD=1)"
fi

echo
echo "Native iOS TestFlight artifact: $IPA_PATH"
echo "Bundle ID: $BUNDLE_ID"
echo "Version: $MARKETING_VERSION ($IOS_BUILD_NUMBER)"
echo "SHA-256: $(shasum -a 256 "$IPA_PATH" | awk '{print $1}')"
