#!/usr/bin/env bash
# Generate a 2048-bit RSA private key + PKCS#10 Certificate Signing Request
# for an Apple Developer ID Application certificate.
#
# All output goes to ~/.flowix-signing/, NEVER inside the repo. The private key
# is generated locally and stays local — only the CSR ever leaves this machine
# (when uploaded to https://developer.apple.com/).
#
# Usage:
#   bash scripts/apple-signing/gen-csr.sh <apple-id-email> <common-name> <org-name> [country-code]
#
# Args:
#   apple-id-email    Email registered with Apple Developer account
#   common-name       Your name as shown on the certificate (ASCII only,
#                     avoid Chinese here — Apple's CLI tools can choke on it)
#   org-name          Must match Apple Developer Account's legal Org name
#                     EXACTLY — case and spacing. Find it at:
#                     developer.apple.com → Membership Details → Organization
#   country-code      ISO 3166-1 alpha-2 (default: US)
#
# Outputs:
#   ~/.flowix-signing/devid.key     private key (NEVER SHARE, NEVER COMMIT)
#   ~/.flowix-signing/devid.csr     CSR to upload to Apple
#
# After running:
#   1. Open https://developer.apple.com/account/resources/certificates/list
#   2. Click "+" → "Developer ID Application" → Continue
#   3. Upload devid.csr → Continue → Download the issued .cer
#   4. Run: bash scripts/apple-signing/make-p12.sh path/to/developerID_application.cer

set -euo pipefail

EMAIL="${1:-}"
CN="${2:-}"
ORG="${3:-}"
COUNTRY="${4:-US}"

if [ -z "$EMAIL" ] || [ -z "$CN" ] || [ -z "$ORG" ]; then
  cat <<EOF >&2
usage: $0 <apple-id-email> <common-name> <org-name> [country-code]

  apple-id-email    Email registered with Apple Developer account.
  common-name       Your name on the certificate. ASCII only.
  org-name          Must EXACTLY match Apple Developer Account's Org name
                    (Membership Details → Organization).
  country-code      ISO 3166-1 alpha-2 (default: US).
EOF
  exit 2
fi

# Sanity-check inputs (don't allow characters that frequently break Apple's tooling)
for var_name in CN ORG; do
  case "${!var_name}" in
    *[![:ascii:]]*) echo "ERROR: $var_name contains non-ASCII characters: ${!var_name}" >&2; exit 2 ;;
  esac
done

if [[ ! "$EMAIL" =~ ^[^@]+@[^@]+\.[^@]+$ ]]; then
  echo "ERROR: invalid email format: $EMAIL" >&2; exit 2
fi

if [[ ! "$COUNTRY" =~ ^[A-Z]{2}$ ]]; then
  echo "ERROR: country must be a 2-letter ISO code, got: $COUNTRY" >&2; exit 2
fi

KEY_DIR="$HOME/.flowix-signing"
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

KEY="$KEY_DIR/devid.key"
CSR="$KEY_DIR/devid.csr"

if [ -f "$KEY" ] && [ -z "${OVERWRITE:-}" ]; then
  echo "ERROR: $KEY already exists. Refusing to overwrite." >&2
  echo "       If intentional, run with OVERWRITE=1 or remove the file first." >&2
  exit 1
fi

echo "==> Generating 2048-bit RSA private key at $KEY"
openssl genrsa -out "$KEY" 2048
chmod 600 "$KEY"

echo "==> Generating CSR at $CSR"
openssl req -new \
  -key "$KEY" \
  -out "$CSR" \
  -subj "/emailAddress=$EMAIL/CN=$CN/O=$ORG/C=$COUNTRY"

echo
echo "=== Created ==="
echo "  private key: $KEY  (do not commit, do not share with anyone)"
echo "  CSR:         $CSR  (upload this)"
echo

# Self-verify so the user sees a green light before uploading
if openssl req -in "$CSR" -noout -text -verify 2>&1 | grep -q "verify OK"; then
  echo "verify OK — CSR is well-formed and ready to upload to Apple"
else
  echo "WARNING: CSR verification did not report OK — investigate before upload" >&2
  exit 1
fi

cat <<EOF

Next steps (these you do in your browser, no credentials go through chat):

  1. Open:
     https://developer.apple.com/account/resources/certificates/list

  2. Click "+" → "Developer ID Application" → Continue

  3. Click "Choose File" → select:
     $CSR

  4. Apple issues a .cer within ~30 seconds. Click "Download" and save the
     .cer somewhere (e.g. ~/Desktop/developerID_application.cer).

  5. Then run:
     bash $0/../make-p12.sh ~/Desktop/developerID_application.cer
EOF
