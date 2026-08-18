#!/usr/bin/env bash
# Verify the exact macOS DMG that will be distributed.
#
# Usage:
#   bash scripts/verify-macos-release.sh --pre-notarize <dmg> <rust-target-triple>
#   bash scripts/verify-macos-release.sh --notarized    <dmg> <rust-target-triple>

set -euo pipefail

MODE="${1:-}"
DMG="${2:-}"
TRIPLE="${3:-}"

if [[ "$MODE" != "--pre-notarize" && "$MODE" != "--notarized" ]] || [ -z "$DMG" ] || [ -z "$TRIPLE" ]; then
  echo "usage: $0 <--pre-notarize|--notarized> <dmg> <rust-target-triple>" >&2
  exit 2
fi

if [ ! -f "$DMG" ]; then
  echo "ERROR: DMG not found: $DMG" >&2
  exit 1
fi

case "$TRIPLE" in
  aarch64-apple-darwin) EXPECTED_ARCH="arm64" ;;
  x86_64-apple-darwin) EXPECTED_ARCH="x86_64" ;;
  *)
    echo "ERROR: unsupported macOS target: $TRIPLE" >&2
    exit 2
    ;;
esac

verify_team_identifier() {
  local code_path="$1"
  local team_identifier
  team_identifier="$(codesign -dv --verbose=4 "$code_path" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -1)"
  if [ -z "$team_identifier" ]; then
    echo "ERROR: signed code has no TeamIdentifier: $code_path" >&2
    return 1
  fi
  if [ -n "${APPLE_TEAM_ID:-}" ] && [ "$team_identifier" != "$APPLE_TEAM_ID" ]; then
    echo "ERROR: TeamIdentifier mismatch for $code_path: expected $APPLE_TEAM_ID, got $team_identifier" >&2
    return 1
  fi
}

verify_dmg_contents() (
  local mount_dir mounted_app binary file_description
  mount_dir="$(mktemp -d)"
  cleanup() {
    hdiutil detach "$mount_dir" -quiet 2>/dev/null || true
    rmdir "$mount_dir" 2>/dev/null || true
  }
  trap cleanup EXIT

  hdiutil attach "$DMG" -mountpoint "$mount_dir" -nobrowse -readonly -quiet
  mounted_app="$(find "$mount_dir" -maxdepth 1 -type d -name '*.app' -print | head -1)"
  if [ -z "$mounted_app" ]; then
    echo "ERROR: DMG does not contain an app bundle: $DMG" >&2
    return 1
  fi

  for name in flowix-cli dsh-host dsh-host-spawn-helper dsh-runtime dsh-runtime-spawn-helper; do
    binary="$mounted_app/Contents/MacOS/$name"
    if [ ! -x "$binary" ]; then
      echo "ERROR: packaged sidecar is missing or not executable: $binary" >&2
      return 1
    fi
    file_description="$(file -b "$binary")"
    if [[ "$file_description" != *"$EXPECTED_ARCH"* ]]; then
      echo "ERROR: packaged sidecar architecture mismatch for $name: expected $EXPECTED_ARCH, got $file_description" >&2
      return 1
    fi
    codesign --verify --strict --verbose=2 "$binary"
    verify_team_identifier "$binary"
  done
  codesign --verify --deep --strict --verbose=2 "$mounted_app"
  verify_team_identifier "$mounted_app"
  echo "==> Verified DMG contents: all $EXPECTED_ARCH sidecars + valid nested signatures"
)

verify_dmg_contents

if [ "$MODE" = "--notarized" ]; then
  xcrun stapler validate "$DMG"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
  echo "==> Verified notarization ticket and Gatekeeper acceptance"
fi
