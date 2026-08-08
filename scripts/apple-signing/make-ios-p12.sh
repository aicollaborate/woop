#!/usr/bin/env bash
# Combine the Apple-issued Apple Distribution (or "iOS Distribution") .cer with
# the matching private key (from gen-ios-csr.sh) into a single .p12 bundle
# (PKCS#12) that ALSO carries the Apple WWDRCA G3 intermediate cert (so
# codesign can build the full chain to Apple's Root CA).
#
# A .p12 is the "complete identity" format — it carries the leaf cert, the
# matching private key, and (optionally) the intermediate cert as one
# encrypted blob. Tauri CLI's iOS build path reads this .p12 via the
# IOS_CERTIFICATE env var (see scripts/build-and-upload-testflight.sh) and
# forwards it to xcodebuild, which decodes it on the fly — so we do NOT need
# to import the .p12 into the Keychain for iOS, unlike the macOS Developer
# ID flow.
#
# Usage:
#   bash scripts/apple-signing/make-ios-p12.sh <path-to-cer>
#   bash scripts/apple-signing/make-ios-p12.sh <path-to-cer> <p12-output-path>
#   bash scripts/apple-signing/make-ios-p12.sh <path-to-cer> <p12-output-path> <export-password>
#
# Args:
#   cer                Path to apple_distribution.cer (or ios_distribution.cer
#                      on Personal accounts) downloaded from Apple Developer
#                      Portal after uploading the CSR.
#   p12-output-path    Where to write the .p12
#                      (default: ~/.flowix-signing/devid-ios.p12)
#   export-password    PKCS#12 export password. Read interactively if not given.
#                      This same password is what you set as
#                      IOS_CERT_P12_PASSWORD when running build-and-upload-
#                      testflight.sh, so don't lose it.
#
# Outputs:
#   The combined .p12 file. Its password is what you set above.

set -euo pipefail

CER="${1:-}"
P12_PATH="${2:-}"
PASSWORD="${3:-}"

if [ -z "$CER" ]; then
  cat <<EOF >&2
usage: $0 <path-to-apple-distribution.cer>

  Pass the .cer file Apple issued after you uploaded devid-ios.csr. You can
  download it from:
    https://developer.apple.com/account/resources/certificates/list
EOF
  exit 2
fi

if [ ! -f "$CER" ]; then
  echo "ERROR: $CER does not exist (or is not a regular file)." >&2
  exit 1
fi

KEY_DIR="$HOME/.flowix-signing"
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

KEY="$KEY_DIR/devid-ios.key"
if [ ! -f "$KEY" ]; then
  echo "ERROR: $KEY not found." >&2
  echo "       Run scripts/apple-signing/gen-ios-csr.sh first." >&2
  exit 1
fi

P12_PATH="${P12_PATH:-$KEY_DIR/devid-ios.p12}"

# 1. .cer (DER-format) → .pem (openssl-friendly)
PEM="$KEY_DIR/devid-ios.pem"
openssl x509 -in "$CER" -inform DER -out "$PEM"

# 1b. Apple's WWDRCA intermediate (G3 for newer Apple Distribution certs).
# Required for codesign to build a valid chain to Apple's Root CA — without
# it, codesign fails with `unable to build chain to self-signed root` and
# `errSecInternalComponent`. Apple pre-installs the WWDRCA cert in every
# macOS keychain, so extract it from there (avoids curl 404 flakiness).
WWDRCA_PEM="$KEY_DIR/AppleWWDRCA_G3.pem"
security find-certificate -c "Apple Worldwide Developer Relations" -p \
  ~/Library/Keychains/login.keychain-db \
  > "$WWDRCA_PEM" 2>/dev/null || {
  echo "ERROR: could not extract Apple WWDRCA from login keychain." >&2
  echo "       Manual fallback:" >&2
  echo "         curl -o $KEY_DIR/AppleWWDRCA_G3.cer \\" >&2
  echo "          https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer" >&2
  echo "         openssl x509 -in $KEY_DIR/AppleWWDRCA_G3.cer -inform DER -out $WWDRCA_PEM" >&2
  exit 1
}
chmod 644 "$WWDRCA_PEM"

# 2. PKCS#12: private key + leaf cert + intermediate → single encrypted bundle
if [ -z "$PASSWORD" ]; then
  echo -n "Enter export password (you'll see it masked — same pw goes into CI secrets as IOS_CERT_P12_PASSWORD): "
  read -rs PASSWORD
  echo
  if [ -z "$PASSWORD" ]; then
    echo "ERROR: empty password is not allowed for PKCS#12." >&2
    exit 1
  fi
  echo -n "Confirm: "
  read -rs CONFIRM
  echo
  if [ "$PASSWORD" != "$CONFIRM" ]; then
    echo "ERROR: passwords do not match." >&2
    exit 1
  fi
fi

# Pull the Apple "common name" out of the cert so the .p12 lands in Keychain
# with a meaningful label instead of the generic "Certificate".
SUBJ="$(openssl x509 -in "$PEM" -noout -subject | sed -e 's/^subject=//' -e 's/^[^=]*=//')"

# `-legacy` flag is REQUIRED for the .p12 to be importable by macOS
# `security import`. Modern OpenSSL defaults to PBES2 + AES-256-CBC, which
# macOS rejects with "MAC verification failed during PKCS12 import" even when
# the password is correct. `-legacy` switches to PBES1 + 3DES + SHA1, which
# is the universal format. Without this flag the Tauri iOS build dies at
# `tauri ios build` time with `failed to import keychain certificate`.
# `-certfile` embeds the WWDRCA G3 intermediate so codesign can build the
# trust chain to Apple's Root CA (see 1b above).
openssl pkcs12 -export -legacy \
  -inkey "$KEY" \
  -in "$PEM" \
  -certfile "$WWDRCA_PEM" \
  -out "$P12_PATH" \
  -name "$SUBJ" \
  -passout "pass:$PASSWORD"

chmod 600 "$P12_PATH"
rm -f "$PEM" "$WWDRCA_PEM"

echo
echo "=== Created ==="
echo "  $P12_PATH"
echo
echo "=== Sanity-check ==="
# Quickly verify the .p12 parses and carries a valid cert + chain
DETAIL="$(openssl pkcs12 -in "$P12_PATH" -nokeys -passin "pass:$PASSWORD" 2>/dev/null \
            | openssl x509 -noout -subject -issuer -dates 2>/dev/null || true)"
if [ -n "$DETAIL" ]; then
  echo "$DETAIL"
  echo
fi

CERT_COUNT=$(openssl pkcs12 -in "$P12_PATH" -nokeys -passin "pass:$PASSWORD" 2>/dev/null \
              | grep -c "BEGIN CERTIFICATE")
echo "Cert count in .p12: $CERT_COUNT (expect 2: leaf + WWDRCA G3 intermediate)"

cat <<EOF

=== What you do now ===

  • Wire it into the TestFlight build:
      export IOS_CERT_P12_PATH="$P12_PATH"
      export IOS_CERT_P12_PASSWORD="<the password you just set>"

    These two env vars are read by scripts/build-and-upload-testflight.sh and
    passed through to Tauri's iOS build (IOS_CERTIFICATE / IOS_CERTIFICATE_
    PASSWORD), which forwards them to xcodebuild.

  • Verify it parses (no Keychain import needed for iOS):
      openssl pkcs12 -in "$P12_PATH" -nokeys -passin "pass:<your-password>"
EOF
