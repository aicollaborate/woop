#!/usr/bin/env bash
# Build Flowix iOS .ipa, verify the artifact, and upload it to TestFlight
# (App Store Connect internal testing).
#
# Mirrors scripts/apple-signing/sign-and-notarize.sh for macOS DMG, but
# adapted for iOS:
#   • tauri ios build --export-method release-testing does the archive +
#     xcodebuild -exportArchive + .ipa assembly (Tauri CLI 2.x natively
#     reads IOS_CERTIFICATE / IOS_CERTIFICATE_PASSWORD / IOS_MOBILE_PROVISION
#     / APPLE_API_KEY / APPLE_API_KEY_PATH / APPLE_API_ISSUER env vars to
#     sign the bundle and feed the ASC API key to xcodebuild)
#   • We do NOT need to write our own ExportOptions.plist — Tauri generates
#     a transient one for the chosen --export-method
#   • Upload goes through `xcrun altool --upload-app --type ios --apiKey ...
#     --apiIssuer ...` (still available in Xcode 26.6; if Apple removes it
#     install Transporter.app CLI as a fallback)
#
# Pre-requisites (one-time setup; see scripts/apple-signing/README.md):
#   • Apple Distribution cert + p12 staged to ~/.flowix-signing/devid-ios.p12
#     (via gen-ios-csr.sh + make-ios-p12.sh)
#   • App Store provisioning profile for com.flowix.app.mobile
#   • App Store Connect API key staged to ~/.flowix-signing/appstoreconnect/
#     (via store-asc-api-key.sh)
#   • App record "Flowix" created on App Store Connect with bundle id
#     com.flowix.app.mobile
#
# Required env vars (none of these should ever be inlined into the script):
#   APPLE_TEAM_ID                10-char Team ID (Membership Details)
#   IOS_CERT_P12_PATH            Absolute path to the Apple Distribution .p12
#   IOS_CERT_P12_PASSWORD        Export password for that .p12
#   IOS_MOBILE_PROVISION_PATH    Absolute path to the .mobileprovision for
#                                com.flowix.app.mobile
#
# Upload auth — choose ONE of two paths:
#   (A) App Store Connect API key (preferred, non-interactive):
#         APPLE_ASC_API_KEY_ID         10-char Key ID
#         APPLE_ASC_API_ISSUER_ID      Issuer UUID
#         APPLE_ASC_API_KEY_PATH       Absolute path to AuthKey_<KEY_ID>.p8
#   (B) App-Specific Password (fallback — generated from appleid.apple.com):
#         APPLE_ID                     Apple Account email
#         APPLE_APP_SPECIFIC_PASSWORD  16-char ASP
#
# Optional env vars:
#   SKIP_BUILD=1                 Re-use an existing .ipa (skip the build step)
#   SKIP_UPLOAD=1                Build + verify only, don't submit to ASC
#   SKIP_VERIFY=1                Skip the verify-ios-release.sh pre-upload gate
#                                (NOT recommended; only for fast iteration)
#
# After upload the build goes into App Store Connect "Processing" for 5-10
# minutes. Open the TestFlight tab and add the build to an internal testing
# group; tester email invites go out from there.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/app/flowix-mobile"
DESKTOP_DIR="$REPO_ROOT/app/flowix-desktop"
DESKTOP_CONF="$DESKTOP_DIR/tauri.conf.json"
VERIFY_IOS="$REPO_ROOT/scripts/verify-ios-release.sh"

# ---- 0. Validate inputs ----
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set - find in developer.apple.com -> Membership Details}"
: "${IOS_CERT_P12_PATH:?IOS_CERT_P12_PATH not set - point at the .p12 from make-ios-p12.sh}"
: "${IOS_CERT_P12_PASSWORD:?IOS_CERT_P12_PASSWORD not set - the export password you used in make-ios-p12.sh}"
: "${IOS_MOBILE_PROVISION_PATH:?IOS_MOBILE_PROVISION_PATH not set - point at the .mobileprovision for com.flowix.app.mobile}"

# Upload auth: pick ONE path. Defaults to (A) API key, but if App-Specific
# Password is set we prefer (B) since it's simpler and doesn't need an ASC
# API key generation round-trip in the browser.
UPLOAD_AUTH="asc-api-key"
UPLOAD_AUTH_FLAGS=()
if [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_ID:-}" ]; then
  if [ -n "${APPLE_ASC_API_KEY_ID:-}" ] || [ -n "${APPLE_ASC_API_KEY_PATH:-}" ]; then
    echo "ERROR: Set EITHER the ASC API key triple OR the Apple ID + App-Specific Password pair, not both." >&2
    exit 2
  fi
  # Apple App-Specific Password format has shifted over the years (originally
  # 16 lowercase letters in xxxx-xxxx-xxxx-xxxx groups; later versions mix
  # case + digits + sometimes specials). Trust whatever appleid.apple.com
  # hands out — xcrun altool will reject invalid passwords downstream with
  # a clear error. No local regex check; that path just causes false negatives.
  if [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
    echo "ERROR: APPLE_APP_SPECIFIC_PASSWORD is empty." >&2
    exit 2
  fi
  UPLOAD_AUTH="app-specific-password"
  UPLOAD_AUTH_FLAGS=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD")
  echo "==> Upload auth: App-Specific Password fallback (Apple ID + 16-char ASP)"
elif [ -n "${APPLE_ASC_API_KEY_ID:-}" ] && [ -n "${APPLE_ASC_API_ISSUER_ID:-}" ] && [ -n "${APPLE_ASC_API_KEY_PATH:-}" ]; then
  if [[ ! "$APPLE_ASC_API_KEY_ID" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "ERROR: APPLE_ASC_API_KEY_ID should be 10 uppercase alphanumeric characters, got: $APPLE_ASC_API_KEY_ID" >&2
    exit 2
  fi
  UPLOAD_AUTH_FLAGS=(--apiKey "$APPLE_ASC_API_KEY_ID" --apiIssuer "$APPLE_ASC_API_ISSUER_ID")
  echo "==> Upload auth: App Store Connect API key"
else
  echo "ERROR: upload auth not configured. Choose ONE of:" >&2
  echo "  (preferred)  export APPLE_ASC_API_KEY_ID / APPLE_ASC_API_ISSUER_ID / APPLE_ASC_API_KEY_PATH" >&2
  echo "               (run scripts/apple-signing/store-asc-api-key.sh to stage the .p8)" >&2
  echo "  (fallback)   export APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD" >&2
  echo "               (generate ASP at appleid.apple.com -> Sign-In and Security -> App-Specific Passwords)" >&2
  exit 2
fi

if [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "ERROR: APPLE_TEAM_ID should be 10 alphanumeric characters, got: $APPLE_TEAM_ID" >&2
  exit 2
fi

for path_var in IOS_CERT_P12_PATH IOS_MOBILE_PROVISION_PATH; do
  if [ ! -f "${!path_var}" ]; then
    echo "ERROR: $path_var (${!path_var}) does not exist or is not a regular file." >&2
    exit 1
  fi
done

if [ "$UPLOAD_AUTH" = "asc-api-key" ] && [ ! -f "$APPLE_ASC_API_KEY_PATH" ]; then
  echo "ERROR: APPLE_ASC_API_KEY_PATH ($APPLE_ASC_API_KEY_PATH) does not exist." >&2
  exit 1
fi

if [ ! -x "$VERIFY_IOS" ]; then
  echo "ERROR: $VERIFY_IOS is missing or not executable." >&2
  exit 1
fi

cd "$REPO_ROOT"

# ---- 1. Build ----
if [ -z "${SKIP_BUILD:-}" ]; then
  echo "==> [build] Refreshing iOS Xcode project + native patches"
  cd app/flowix-mobile && ../../node_modules/.bin/tauri ios init --ci --skip-targets-install
  cd "$REPO_ROOT"
  node scripts/patch-ios-native.mjs

  echo "==> [build] running tauri ios init + patch (project setup only; we skip tauri ios build because it corrupts pbxproj in 2.11.x)"
  cd "$MOBILE_DIR"
  PATH="$REPO_ROOT/node_modules/.bin:$PATH" ../../node_modules/.bin/tauri ios init --ci --skip-targets-install
  cd "$REPO_ROOT"
  node scripts/patch-ios-native.mjs

  # Stage the .mobileprovision into the system profiles dir under its inner-UUID
  # filename — that's what xcodebuild looks up at archive time.
  PROFILES_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
  mkdir -p "$PROFILES_DIR"
  PROV_UUID="$(security cms -D -i "$IOS_MOBILE_PROVISION_PATH" 2>/dev/null | plutil -extract UUID raw - 2>/dev/null || true)"
  if [ -z "$PROV_UUID" ]; then
    echo "ERROR: cannot extract UUID from $IOS_MOBILE_PROVISION_PATH." >&2
    exit 1
  fi
  cp "$IOS_MOBILE_PROVISION_PATH" "$PROFILES_DIR/$PROV_UUID.mobileprovision"
  echo "==> [build] staged provision: $PROFILES_DIR/$PROV_UUID.mobileprovision"

  # Import .p12 into Keychain so codesign/xcodebuild can find the identity.
  # macOS may import it with CSSMERR_TP_NOT_TRUSTED, which makes
  # `find-identity -v -p codesigning` filter it out. We DON'T try to set
  # custom trust (xcodebuild rejects "Invalid trust settings" if we do) —
  # instead we use the cert's SHA-1 fingerprint directly when calling
  # codesign / xcodebuild, which bypasses the trust lookup entirely.
  CER_FROM_P12="$(mktemp -t flowix.cer).cer"
  openssl pkcs12 -legacy -in "$IOS_CERT_P12_PATH" -nokeys -clcerts -passin "pass:$IOS_CERT_P12_PASSWORD" -out "$CER_FROM_P12" 2>/dev/null
  security import "$IOS_CERT_P12_PATH" -P "$IOS_CERT_P12_PASSWORD" -T /usr/bin/codesign -A -k ~/Library/Keychains/login.keychain-db 2>/dev/null || true
  rm -f "$CER_FROM_P12"

  # Unlock the login keychain so codesign can use the imported identity.
  # Without this, codesign fails with errSecInternalComponent / -67062.
  if security unlock-keychain -p "$IOS_CERT_P12_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null; then
    echo "==> [build] login keychain unlocked"
  else
    echo "WARN: could not unlock login keychain with .p12 password; codesign may fail"
  fi

  # Resolve the cert's SHA-1 fingerprint to use as a trust-bypass code-sign
  # identity. xcodebuild and codesign both accept this format:
  #   "<SHA-1 fingerprint> = Apple Distribution: Yin Liao (9FJ9ZD86C2)"
  CERT_SHA1="$(security find-certificate -a -c 'Apple Distribution' -Z login.keychain-db 2>/dev/null | awk '/SHA-1 hash/ {print $3}' | head -1)"
  if [ -z "$CERT_SHA1" ]; then
    echo "ERROR: cannot locate Apple Distribution cert in keychain after .p12 import." >&2
    exit 1
  fi
  IDENTITY="${CERT_SHA1}"
  echo "==> [build] identity fingerprint: ${CERT_SHA1} (Apple Distribution: Yin Liao (9FJ9ZD86C2))"
  echo "          (using fingerprint instead of friendly name to bypass CSSMERR_TP_NOT_TRUSTED trust filter)"

  # Build the Rust cdylib that the .app links against. We do this directly
  # (not through Tauri CLI's xcode-script which expects a live dev server
  # addr file and panics when it can't find one). We mimic the .a path
  # xcode-script would produce: $MOBILE_DIR/gen/apple/Externals/arm64/release/
  #
  # swift-rs (Tauri's iOS build dep) build.rs does `git clone
  # github.com/Brendonovich/swift-rs`; local git HTTP/2 intermittently fails
  # with "Error in the HTTP2 framing layer". Force HTTP/1.1 for that clone.
  echo "==> [build] cargo build --release --target aarch64-apple-ios (aarch64 device)"
  cd "$MOBILE_DIR"
  CARGO_TARGET_DIR="$REPO_ROOT/.build/cargo-target" \
  GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=http.version \
  GIT_CONFIG_VALUE_0=HTTP/1.1 \
    cargo build --release --target aarch64-apple-ios --no-default-features 2>&1 | tail -10
  cd "$REPO_ROOT"

  # The Xcode project expects libapp.a at gen/apple/Externals/<arch>/<config>/libapp.a
  # (this is what preBuildScripts used to produce — see the preBuildScripts
  # removal in patch-ios-native.mjs). Copy our cargo output there.
  CARGO_LIB="$REPO_ROOT/.build/cargo-target/aarch64-apple-ios/release/libflowix_mobile.a"
  XCODE_EXTERNALS="$MOBILE_DIR/gen/apple/Externals"
  if [ ! -f "$CARGO_LIB" ]; then
    echo "ERROR: cargo output not found at $CARGO_LIB" >&2
    exit 1
  fi
  mkdir -p "$XCODE_EXTERNALS/arm64/release" "$XCODE_EXTERNALS/x86_64/release"
  cp "$CARGO_LIB" "$XCODE_EXTERNALS/arm64/release/libapp.a"
  # x86_64 link isn't needed for aarch64-only builds but we mirror for completeness
  echo "==> [build] copied $CARGO_LIB -> $XCODE_EXTERNALS/arm64/release/libapp.a"

  ARCHIVE_DIR="$REPO_ROOT/.build/ios-archive"
  rm -rf "$ARCHIVE_DIR"
  mkdir -p "$ARCHIVE_DIR"

  echo "==> [archive] xcodebuild archive (skip signing; we'll sign manually after)"
  # Apply the J workaround for `tauri ios xcode-script` resolving the desktop
  # project first in this monorepo. See [[flowix-mobile-ios-dev-launch]].
  if [ -f "$DESKTOP_CONF.bak" ]; then
    echo "ERROR: $DESKTOP_CONF.bak already exists — a previous run exited before its trap restored the desktop conf." >&2
    echo "       Inspect / restore manually before retrying:" >&2
    echo "         ls -la $DESKTOP_CONF*" >&2
    echo "         mv $DESKTOP_CONF.bak $DESKTOP_CONF   # if .json is missing" >&2
    echo "         rm $DESKTOP_CONF.bak                # if .json is correct and stale .bak is leftover" >&2
    exit 1
  fi
  mv "$DESKTOP_CONF" "$DESKTOP_CONF.bak"
  trap 'mv -f "$DESKTOP_CONF.bak" "$DESKTOP_CONF" 2>/dev/null || true' EXIT INT TERM
  cd "$MOBILE_DIR/gen/apple"
  xcodebuild \
    -workspace flowix-mobile.xcodeproj/project.xcworkspace \
    -scheme flowix-mobile_iOS \
    -configuration release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_DIR/flowix-mobile.xcarchive" \
    CODE_SIGN_IDENTITY="" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGN_STYLE=Manual \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    PROVISIONING_PROFILE_SPECIFIER="$PROV_UUID" \
    PRODUCT_BUNDLE_IDENTIFIER=com.flowix.app.mobile \
    archive 2>&1 | tail -10
  cd "$REPO_ROOT"

  if [ ! -d "$ARCHIVE_DIR/flowix-mobile.xcarchive" ]; then
    echo "ERROR: xcarchive not produced under $ARCHIVE_DIR/." >&2
    exit 1
  fi

  # Manually sign the .app inside the xcarchive. codesign's identity-string
  # lookup honors the SHA-1 fingerprint form, bypassing the trust-filter that
  # xcodebuild's own signing path was tripping over.
  APP_DIR_IN_ARCHIVE="$ARCHIVE_DIR/flowix-mobile.xcarchive/Products/Applications/Flowix.app"
  if [ ! -d "$APP_DIR_IN_ARCHIVE" ]; then
    echo "ERROR: .app not found inside xcarchive at $APP_DIR_IN_ARCHIVE." >&2
    exit 1
  fi
  echo "==> [sign] codesign --force --sign $IDENTITY $APP_DIR_IN_ARCHIVE"
  codesign --force --sign "$IDENTITY" \
    --entitlements "$MOBILE_DIR/gen/apple/flowix-mobile_iOS/flowix-mobile_iOS.entitlements" \
    --generate-entitlement-der \
    "$APP_DIR_IN_ARCHIVE" 2>&1 | tail -5
  echo "==> [sign] codesign verify ..."
  codesign --verify --strict --verbose=2 "$APP_DIR_IN_ARCHIVE" 2>&1 | tail -5
  cp "$IOS_MOBILE_PROVISION_PATH" "$APP_DIR_IN_ARCHIVE/embedded.mobileprovision"
  echo "==> [sign] embedded.mobileprovision copied"

  EXPORT_DIR="$REPO_ROOT/.build/ios-export"
  rm -rf "$EXPORT_DIR"
  mkdir -p "$EXPORT_DIR"

  EXPORT_PLIST="$REPO_ROOT/.build/ExportOptions-testflight.plist"
  cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>release-testing</string>
  <key>teamID</key>
  <string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>uploadSymbols</key>
  <true/>
  <key>uploadBitcode</key>
  <false/>
</dict>
</plist>
EOF

  echo "==> [export] xcodebuild -exportArchive (uses already-signed .app inside xcarchive)"
  xcodebuild \
    -exportArchive \
    -archivePath "$ARCHIVE_DIR/flowix-mobile.xcarchive" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_PLIST" 2>&1 | tail -10

  IPA_PATH="$(find "$EXPORT_DIR" -name "*.ipa" -type f 2>/dev/null | head -1 || true)"
  if [ -z "$IPA_PATH" ] || [ ! -f "$IPA_PATH" ]; then
    echo "ERROR: .ipa not produced under $EXPORT_DIR." >&2
    exit 1
  fi
  echo "==> [artifact] $IPA_PATH"
else
  echo "==> [build] Skipping build (SKIP_BUILD=1) - re-using existing .ipa"
fi

# ---- 2. Locate the .ipa ----
# Tauri CLI drops the archive under gen/apple/build/...; the .ipa lands beside
# the .app after xcodebuild -exportArchive. Search broadly so we tolerate
# minor version differences in the exact subdir name.
IPA_PATH="$(find app/flowix-mobile/gen/apple/build -name '*.ipa' -type f 2>/dev/null | head -1 || true)"
if [ -z "$IPA_PATH" ] || [ ! -f "$IPA_PATH" ]; then
  echo "ERROR: .ipa not found under app/flowix-mobile/gen/apple/build/." >&2
  echo "       Check the build log above for xcodebuild/archive errors." >&2
  exit 1
fi
echo "==> [artifact] $IPA_PATH"

# ---- 3. Pre-upload verification ----
if [ -z "${SKIP_VERIFY:-}" ]; then
  echo "==> [verify] Running verify-ios-release.sh pre-upload gate"
  APPLE_TEAM_ID="$APPLE_TEAM_ID" bash "$VERIFY_IOS" "$IPA_PATH"
else
  echo "==> [verify] Skipping verify-ios-release.sh (SKIP_VERIFY=1) - NOT recommended"
fi

# ---- 4. Upload to TestFlight ----
if [ -z "${SKIP_UPLOAD:-}" ]; then
  echo "==> [upload] xcrun altool --upload-app --type ios ($UPLOAD_AUTH)"
  xcrun altool --upload-app \
    --type ios \
    "${UPLOAD_AUTH_FLAGS[@]}" \
    -f "$IPA_PATH" \
    --output-format xml
else
  echo "==> [upload] Skipping upload (SKIP_UPLOAD=1) - build + verify only"
fi

# ---- 5. Done ----
echo
echo "================================================="
echo "  IPA:        $IPA_PATH"
echo "  SHA-256:    $(shasum -a 256 "$IPA_PATH" | awk '{print $1}')"
echo "================================================="
echo
echo "  Next: App Store Connect usually processes the build in 5-10 min."
echo "        Open https://appstoreconnect.apple.com → My Apps → Flowix →"
echo "        TestFlight → Internal Testing → pick the new build → invite testers."
echo
