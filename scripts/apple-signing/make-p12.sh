#!/usr/bin/env bash
# Combine the Apple-issued Developer ID Application .cer with the matching
# private key (from gen-csr.sh) into a single .p12 bundle (PKCS#12).
#
# A .p12 is the "complete identity" format — it carries both the certificate
# and the private key as one encrypted blob. Importing a .p12 into Keychain
# (or to a CI runner) sidesteps the Keychain error
#   "在钥匙串中找不到指定的项" (The specified item could not be found)
# that you hit when importing a bare .cer whose matching private key lived
# in a different keychain (the GUI flow puts them in two places that have
# to be cross-referenced; a .p12 doesn't).
#
# Usage:
#   bash scripts/apple-signing/make-p12.sh <path-to-cer>
#   bash scripts/apple-signing/make-p12.sh <path-to-cer> <p12-output-path>
#   bash scripts/apple-signing/make-p12.sh <path-to-cer> <p12-output-path> <export-password>
#
# Args:
#   cer                Path to developerID_application.cer downloaded from
#                     Apple Developer Portal after uploading the CSR.
#   p12-output-path    Where to write the .p12 (default: ~/.flowix-signing/devid.p12)
#   export-password    PKCS#12 export password. Read interactively if not given.
#                     This same password is what you store in CI as
#                     APPLE_CERT_PASSWORD, so don't lose it.
#
# Outputs:
#   The combined .p12 file. Its password is what you set above.

set -euo pipefail

CER="${1:-}"
P12_PATH="${2:-}"
PASSWORD="${3:-}"

if [ -z "$CER" ]; then
  cat <<EOF >&2
usage: $0 <path-to-developerid-application.cer>

  Pass the .cer file Apple issued after you uploaded devid.csr. You can
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

KEY="$KEY_DIR/devid.key"
if [ ! -f "$KEY" ]; then
  echo "ERROR: $KEY not found." >&2
  echo "       Run scripts/apple-signing/gen-csr.sh first." >&2
  exit 1
fi

P12_PATH="${P12_PATH:-$KEY_DIR/devid.p12}"

# 1. .cer (DER-format) → .pem (openssl-friendly)
PEM="$KEY_DIR/devid.pem"
openssl x509 -in "$CER" -inform DER -out "$PEM"

# 2. PKCS#12: private key + cert → single encrypted bundle
if [ -z "$PASSWORD" ]; then
  echo -n "Enter export password (you'll see it masked — same pw goes into CI secrets): "
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

openssl pkcs12 -export \
  -inkey "$KEY" \
  -in "$PEM" \
  -out "$P12_PATH" \
  -name "$SUBJ" \
  -passout "pass:$PASSWORD"

chmod 600 "$P12_PATH"
rm -f "$PEM"

echo
echo "=== Created ==="
echo "  $P12_PATH"
echo
echo "=== Sanity-check ==="
# Quickly verify the .p12 contains a usable code-signing identity
DETAIL="$(openssl pkcs12 -in "$P12_PATH" -nokeys -passin "pass:$PASSWORD" 2>/dev/null \
            | openssl x509 -noout -subject -issuer -dates 2>/dev/null || true)"
if [ -n "$DETAIL" ]; then
  echo "$DETAIL"
  echo
fi

cat <<EOF

=== What you do now ===

  • Local development:
      open $P12_PATH
      (Keychain prompts for the export password you just set; on success the
      identity appears in the "login" keychain under "My Certificates".)

  • CI / GitHub Actions:
      base64 -i "$P12_PATH" | pbcopy
      paste into the repo's GitHub secret APPLE_CERT_P12_BASE64
      the export password goes into APPLE_CERT_PASSWORD

  • Verify the codesigning identity:
      security find-identity -v -p codesigning
      (one of the listed lines will read like:
       "Developer ID Application: Your Name (TEAMID)" — copy that exact
       string; it goes into scripts/apple-signing/sign-and-notarize.sh
       via APPLE_SIGNING_IDENTITY.)
EOF
