#!/usr/bin/env bash
# Build Flowix iOS .ipa, verify the artifact, and upload it to TestFlight
# (App Store Connect internal testing).
#
# Mirrors scripts/apple-signing/sign-and-notarize.sh for macOS DMG, but
# adapted for iOS:
#   • xcodebuild archive + export with the App Store method does the archive +
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

# Keep the marketing version at 1.1.15 while giving every TestFlight upload a
# monotonically new CFBundleVersion. Override this when reproducing a build.
IOS_BUILD_NUMBER="${IOS_BUILD_NUMBER:-$(date +%s)}"
if [[ ! "$IOS_BUILD_NUMBER" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "ERROR: IOS_BUILD_NUMBER must contain one to three numeric components, got: $IOS_BUILD_NUMBER" >&2
  exit 2
fi
export IOS_BUILD_NUMBER
echo "==> iOS marketing version: $(node -p 'require("./app/flowix-mobile/tauri.conf.json").version') (build $IOS_BUILD_NUMBER)"

# ---- 1. Build ----
if [ -z "${SKIP_BUILD:-}" ]; then
  echo "==> [build] running tauri ios init + patch (project setup only; we skip tauri ios build because it corrupts pbxproj in 2.11.x)"
  cd "$MOBILE_DIR"
  PATH="$REPO_ROOT/node_modules/.bin:$PATH" ../../node_modules/.bin/tauri ios init --ci --skip-targets-install
  cd "$REPO_ROOT"
  node scripts/patch-ios-native.mjs

  # This pipeline deliberately skips `tauri ios build` because the current
  # Tauri CLI version corrupts the generated pbxproj on this monorepo layout.
  # That also means its beforeBuildCommand is not run for us. Build the mobile
  # frontend explicitly before cargo embeds frontendDist into the release
  # binary; otherwise a stale desktop bundle (or no bundle) can be published.
  echo "==> [build] npm run build:mobile"
  npm run build:mobile

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

  # Use a fresh, isolated keychain for the distribution identity.  A stale or
  # conflicting copy in the login keychain can make codesign fail with
  # errSecInternalComponent even though `security find-identity` reports the
  # certificate as valid. The temporary keychain is removed at exit and never
  # changes the user's login keychain ACL.
  SIGNING_KEYCHAIN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flowix-ios-signing.XXXXXX")"
  KEYCHAIN_PATH="$SIGNING_KEYCHAIN_DIR/ios-signing.keychain-db"
  cleanup_signing_keychain() {
    security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
    rmdir "$SIGNING_KEYCHAIN_DIR" >/dev/null 2>&1 || true
  }
  trap cleanup_signing_keychain EXIT INT TERM

  echo "==> [build] creating isolated signing keychain"
  security create-keychain -p "$IOS_CERT_P12_PASSWORD" "$KEYCHAIN_PATH"
  security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
  security unlock-keychain -p "$IOS_CERT_P12_PASSWORD" "$KEYCHAIN_PATH"
  security import "$IOS_CERT_P12_PATH" -P "$IOS_CERT_P12_PASSWORD" \
    -T /usr/bin/codesign -A -k "$KEYCHAIN_PATH"

  # `security import` may omit the intermediate bundled in a PKCS#12. Because
  # codesign below is explicitly scoped to this keychain, add the current
  # WWDR G3 intermediate as well so it can build the Apple Distribution chain.
  WWDR_CANDIDATES_PEM="$SIGNING_KEYCHAIN_DIR/WWDRCandidates.pem"
  security find-certificate -a -c "Apple Worldwide Developer Relations" -p \
    /Library/Keychains/System.keychain > "$WWDR_CANDIDATES_PEM"
  awk -v dir="$SIGNING_KEYCHAIN_DIR" \
    '/BEGIN CERTIFICATE/ { n++ } n { print > (dir "/wwdr-" n ".pem") }' \
    "$WWDR_CANDIDATES_PEM"
  WWDRCA_PEM=""
  for wwdr_candidate in "$SIGNING_KEYCHAIN_DIR"/wwdr-*.pem; do
    if openssl x509 -in "$wwdr_candidate" -noout -subject | grep -q 'OU=G3'; then
      WWDRCA_PEM="$wwdr_candidate"
      break
    fi
  done
  if [ -z "$WWDRCA_PEM" ]; then
    echo "ERROR: Apple WWDR G3 intermediate not found in the system keychain." >&2
    exit 1
  fi
  if ! security find-certificate -c "Apple Worldwide Developer Relations" -p \
    "$KEYCHAIN_PATH" 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | grep -q 'OU=G3'; then
    security import "$WWDRCA_PEM" -k "$KEYCHAIN_PATH"
  else
    echo "==> [build] WWDR G3 intermediate already present in isolated keychain"
  fi

  # WWDR G3 chains to the original "Apple Root CA" (not "Apple Root CA - G3").
  # Trust that exact root for code signing inside this temporary keychain so a
  # user-level trust override in login.keychain cannot affect this build.
  APPLE_ROOTS_PEM="$SIGNING_KEYCHAIN_DIR/AppleRoots.pem"
  security find-certificate -a -c "Apple Root CA" -p \
    /System/Library/Keychains/SystemRootCertificates.keychain > "$APPLE_ROOTS_PEM"
  awk -v dir="$SIGNING_KEYCHAIN_DIR" \
    '/BEGIN CERTIFICATE/ { n++ } n { print > (dir "/apple-root-" n ".pem") }' \
    "$APPLE_ROOTS_PEM"
  APPLE_ROOT_PEM=""
  for root_candidate in "$SIGNING_KEYCHAIN_DIR"/apple-root-*.pem; do
    if openssl x509 -in "$root_candidate" -noout -subject | grep -q 'CN=Apple Root CA$'; then
      APPLE_ROOT_PEM="$root_candidate"
      break
    fi
  done
  if [ -z "$APPLE_ROOT_PEM" ]; then
    echo "ERROR: original Apple Root CA not found in the system root store." >&2
    exit 1
  fi
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN_PATH" "$APPLE_ROOT_PEM"
  security set-key-partition-list -S apple-tool:,apple: -s \
    -k "$IOS_CERT_P12_PASSWORD" "$KEYCHAIN_PATH"

  # Resolve the cert's SHA-1 fingerprint to use as a trust-bypass code-sign
  # identity. xcodebuild and codesign both accept this format:
  #   "<SHA-1 fingerprint> = Apple Distribution: Yin Liao (9FJ9ZD86C2)"
  CERT_SHA1="$(security find-certificate -a -c 'Apple Distribution' -Z "$KEYCHAIN_PATH" 2>/dev/null | awk '/SHA-1 hash/ {print $3}' | head -1)"
  if [ -z "$CERT_SHA1" ]; then
    echo "ERROR: cannot locate Apple Distribution cert in keychain after .p12 import." >&2
    exit 1
  fi
  IDENTITY="${CERT_SHA1}"
  echo "==> [build] identity fingerprint: ${CERT_SHA1} (Apple Distribution: Yin Liao (9FJ9ZD86C2))"
  echo "          (using the isolated signing keychain)"

  # Build the Rust cdylib that the .app links against. We do this directly
  # (not through Tauri CLI's xcode-script which expects a live dev server
  # addr file and panics when it can't find one). We mimic the .a path
  # xcode-script would produce: $MOBILE_DIR/gen/apple/Externals/arm64/release/
  #
  # swift-rs (Tauri's iOS build dep) build.rs does `git clone
  # github.com/Brendonovich/swift-rs`; local git HTTP/2 intermittently fails
  # with "Error in the HTTP2 framing layer". Force HTTP/1.1 for that clone.
  echo "==> [build] cargo build --release --target aarch64-apple-ios --features custom-protocol (aarch64 device)"
  cd "$MOBILE_DIR"
  IOS_MINIMUM_SYSTEM_VERSION="$(node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync("app/flowix-mobile/tauri.ios.conf.json", "utf8")); console.log(config.bundle.iOS.minimumSystemVersion)')"
  IPHONEOS_DEPLOYMENT_TARGET="$IOS_MINIMUM_SYSTEM_VERSION" \
  CARGO_TARGET_DIR="$REPO_ROOT/.build/cargo-target" \
  GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=http.version \
  GIT_CONFIG_VALUE_0=HTTP/1.1 \
    cargo build --release --target aarch64-apple-ios --no-default-features --features custom-protocol 2>&1 | tail -10
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
  trap 'mv -f "$DESKTOP_CONF.bak" "$DESKTOP_CONF" 2>/dev/null || true; cleanup_signing_keychain' EXIT INT TERM
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
    --keychain "$KEYCHAIN_PATH" \
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
  <string>app-store-connect</string>
  <key>teamID</key>
  <string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.flowix.app.mobile</key>
    <string>$PROV_UUID</string>
  </dict>
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
# A normal build already found the IPA in $EXPORT_DIR.  When SKIP_BUILD=1,
# search both the current export location and Tauri's historical location.
if [ -z "${IPA_PATH:-}" ] || [ ! -f "$IPA_PATH" ]; then
  IPA_PATH="$(find "$REPO_ROOT/.build/ios-export" "$MOBILE_DIR/gen/apple/build" \
    -name '*.ipa' -type f 2>/dev/null | head -1 || true)"
fi
if [ -z "$IPA_PATH" ] || [ ! -f "$IPA_PATH" ]; then
  echo "ERROR: .ipa not found under .build/ios-export or app/flowix-mobile/gen/apple/build/." >&2
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
  XCODE_CONTENTS_DIR="$(dirname "$(xcode-select -p)")"
  ALTOOL_BIN="$XCODE_CONTENTS_DIR/SharedFrameworks/ContentDelivery.framework/Resources/altool"
  if [ ! -x "$ALTOOL_BIN" ]; then
    echo "ERROR: Xcode ContentDelivery altool not found at $ALTOOL_BIN" >&2
    exit 1
  fi
  echo "==> [upload] altool --upload-app --type ios ($UPLOAD_AUTH)"
  API_PRIVATE_KEYS_DIR="$(dirname "$APPLE_ASC_API_KEY_PATH")" "$ALTOOL_BIN" --upload-app \
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
