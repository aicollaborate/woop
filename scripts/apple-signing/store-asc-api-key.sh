#!/usr/bin/env bash
# Stage an App Store Connect API key into ~/.flowix-signing/appstoreconnect/,
# with 0600 perms and sidecar .keyid / .issuerid files for the build pipeline.
#
# App Store Connect API keys are how we authenticate xcrun altool --upload-app
# (and Tauri CLI's APPLE_API_KEY*) without an interactive Apple ID login.
# The .p8 file is a PKCS#8 PEM private key — Apple only lets you DOWNLOAD IT
# ONCE, immediately after generation, so stash it carefully.
#
# Usage:
#   bash scripts/apple-signing/store-asc-api-key.sh <path-to-AuthKey.p8> <key-id> <issuer-id>
#
# Args:
#   path-to-AuthKey.p8   Path to the AuthKey_XXXXXXXX.p8 you downloaded from
#                         App Store Connect → Users and Access → Keys.
#   key-id               10-character alphanumeric Key ID shown on the Keys page.
#   issuer-id            UUID Issuer ID shown at the top of the Keys page.
#
# Outputs:
#   ~/.flowix-signing/appstoreconnect/AuthKey_<KEY_ID>.p8  (0600)
#   ~/.flowix-signing/appstoreconnect/.keyid              (0600, contains KEY_ID)
#   ~/.flowix-signing/appstoreconnect/.issuerid           (0600, contains ISSUER_ID)
#
# After running:
#   • Wire it into the TestFlight build:
#       export APPLE_ASC_API_KEY_ID="<key-id>"
#       export APPLE_ASC_API_ISSUER_ID="<issuer-id>"
#       export APPLE_ASC_API_KEY_PATH="$HOME/.flowix-signing/appstoreconnect/AuthKey_<key-id>.p8"

set -euo pipefail

SRC="${1:-}"
KEY_ID="${2:-}"
ISSUER_ID="${3:-}"

if [ -z "$SRC" ] || [ -z "$KEY_ID" ] || [ -z "$ISSUER_ID" ]; then
  cat <<EOF >&2
usage: $0 <path-to-AuthKey_XXXXXXXX.p8> <key-id> <issuer-id>

  Generate the key at:
    https://appstoreconnect.apple.com/access/api

  Pick role "App Manager" or "Admin" (Developer can't upload builds).
  Download the .p8 ONCE — Apple will not let you download it again.
EOF
  exit 2
fi

if [ ! -f "$SRC" ]; then
  echo "ERROR: $SRC does not exist (or is not a regular file)." >&2
  exit 1
fi

# Key ID: Apple shows 10 alphanumeric chars
if [[ ! "$KEY_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "ERROR: KEY_ID should be 10 uppercase alphanumeric characters, got: $KEY_ID" >&2
  exit 2
fi

# Issuer ID: UUID v4 shape (8-4-4-4-12 hex)
if [[ ! "$ISSUER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "ERROR: ISSUER_ID should be a UUID, got: $ISSUER_ID" >&2
  exit 2
fi

DST_DIR="$HOME/.flowix-signing/appstoreconnect"
mkdir -p "$DST_DIR"
chmod 700 "$DST_DIR"

DST="$DST_DIR/AuthKey_$KEY_ID.p8"
if [ -f "$DST" ] && [ -z "${OVERWRITE:-}" ]; then
  echo "ERROR: $DST already exists. Refusing to overwrite." >&2
  echo "       If intentional, run with OVERWRITE=1 or remove the file first." >&2
  exit 1
fi

# P8 is PKCS#8 PEM — must start with the BEGIN PRIVATE KEY header. (Older Apple
# keys used EC with a different header; newer ones all use PKCS#8.)
FIRST_BYTES="$(head -c 30 "$SRC" || true)"
if ! grep -q "BEGIN PRIVATE KEY" <<<"$FIRST_BYTES"; then
  echo "WARNING: $SRC does not start with '-----BEGIN PRIVATE KEY-----'." >&2
  echo "         Apple issued keys should be PKCS#8 PEM. Double-check the file." >&2
  if [ -z "${FORCE:-}" ]; then
    echo "         Re-run with FORCE=1 to accept anyway." >&2
    exit 1
  fi
fi

cp "$SRC" "$DST"
chmod 600 "$DST"

printf '%s' "$KEY_ID" > "$DST_DIR/.keyid"
chmod 600 "$DST_DIR/.keyid"

printf '%s' "$ISSUER_ID" > "$DST_DIR/.issuerid"
chmod 600 "$DST_DIR/.issuerid"

echo
echo "=== Staged ==="
echo "  $DST"
echo "  $DST_DIR/.keyid"
echo "  $DST_DIR/.issuerid"
echo
echo "=== Sanity-check ==="
echo "  Key ID:     $(cat "$DST_DIR/.keyid")"
echo "  Issuer ID:  $(cat "$DST_DIR/.issuerid")"
echo "  File size:  $(wc -c < "$DST") bytes"

cat <<EOF

=== What you do now ===

  • Wire it into the TestFlight build (paste these into your shell rc):

      export APPLE_ASC_API_KEY_ID="$(cat "$DST_DIR/.keyid")"
      export APPLE_ASC_API_ISSUER_ID="$(cat "$DST_DIR/.issuerid")"
      export APPLE_ASC_API_KEY_PATH="$DST"

    These three env vars are read by scripts/build-and-upload-testflight.sh
    and passed to xcrun altool --upload-app --apiKey ... --apiIssuer ... -f ...

  • The .p8 file never expires, but if the team-member who generated it loses
    access, generate a new key and re-run this script.
EOF
