#!/usr/bin/env bash
# Build and optionally publish the standalone, headless Flowix DSH package.
#
# Local build:
#   bash scripts/release-dsh.sh
# Publish a complete four-platform set already built on native runners:
#   DSH_PUBLISH=1 FLOWIX_DSH_SKIP_BUILD=1 \
#   FLOWIX_DSH_TARGETS=node24-macos-arm64,node24-macos-x64,node24-linux-x64,node24-windows-x64 \
#   bash scripts/release-dsh.sh
# Required for publishing:
#   FLOWIX_DSH_SIGNING_PRIVATE_KEY_PATH=/secure/path/dsh.key

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${FLOWIX_DSH_VERSION:-$(node -p "require('./dsh-flowix-host/package.json').version")}"
OUT_DIR="${FLOWIX_DSH_RELEASE_OUT:-$REPO_ROOT/.build/releases/dsh}"
BUCKET="${FLOWIX_DSH_R2_BUCKET:-flowix-downloads}"
PREFIX="${FLOWIX_DSH_R2_PREFIX:-dsh/v${VERSION}}"

cd "$REPO_ROOT"
if [[ "${DSH_PUBLISH:-0}" == "1" ]]; then
  if [[ -z "${FLOWIX_DSH_SIGNING_PRIVATE_KEY:-}" && -z "${FLOWIX_DSH_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
    echo "release-dsh.sh: DSH_PUBLISH=1 requires FLOWIX_DSH_SIGNING_PRIVATE_KEY or FLOWIX_DSH_SIGNING_PRIVATE_KEY_PATH" >&2
    exit 1
  fi
  export FLOWIX_DSH_REQUIRE_SIGNATURE=1
  if [[ "${FLOWIX_DSH_SKIP_BUILD:-0}" != "1" ]]; then
    echo "release-dsh.sh: production publishing requires FLOWIX_DSH_SKIP_BUILD=1 and all prebuilt targets" >&2
    exit 1
  fi
fi
if [[ -z "${FLOWIX_DSH_TARGETS:-}" ]]; then
  FLOWIX_DSH_TARGETS="$(node -p "'node24-' + (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform) + '-' + (process.arch === 'arm64' ? 'arm64' : 'x64')")"
fi
if [[ "${DSH_PUBLISH:-0}" == "1" ]]; then
  for required in node24-macos-arm64 node24-macos-x64 node24-linux-x64 node24-windows-x64; do
    case ",$FLOWIX_DSH_TARGETS," in
      *",$required,"*) ;;
      *)
        echo "release-dsh.sh: stable manifest is missing required target $required" >&2
        exit 1
        ;;
    esac
  done
fi

if [[ "${FLOWIX_DSH_SKIP_BUILD:-0}" != "1" ]]; then
  if [[ "$FLOWIX_DSH_TARGETS" == *,* ]]; then
    echo "release-dsh.sh: one native Node architecture can build one managed runtime target; build each target under its matching Node and rerun with FLOWIX_DSH_SKIP_BUILD=1 to package prebuilt targets" >&2
    exit 1
  fi
  npm run dsh:build:prod -- --target="$FLOWIX_DSH_TARGETS"
fi
FLOWIX_DSH_R2_PREFIX="$PREFIX" npm run dsh:package -- --targets="$FLOWIX_DSH_TARGETS"

if [[ "${DSH_PUBLISH:-0}" != "1" ]]; then
  echo "publish skipped; set DSH_PUBLISH=1 to upload DSH archives"
  exit 0
fi

WRANGLER="${WRANGLER:-$(command -v wrangler || true)}"
if [[ -z "$WRANGLER" ]]; then
  echo "release-dsh.sh: wrangler is required when DSH_PUBLISH=1" >&2
  exit 1
fi

while IFS= read -r artifact; do
  name="$(basename "$artifact")"
  "$WRANGLER" r2 object put "$BUCKET/$PREFIX/$name" --file "$artifact" --remote
done < <(find "$OUT_DIR" -maxdepth 1 -type f -name 'Flowix-DSH_*' -print)

"$WRANGLER" r2 object put "$BUCKET/$PREFIX/dsh-latest.json" \
  --file "$OUT_DIR/dsh-latest.json" --remote

# Stable channel consumed by the standalone DSH client. Keep the versioned
# copy above for auditability and rollback, while this pointer is updated only
# after the versioned archive has been uploaded.
"$WRANGLER" r2 object put "$BUCKET/dsh/latest.json" \
  --file "$OUT_DIR/dsh-latest.json" --remote

echo "published DSH ${VERSION}"
echo "    manifest: https://download.flowix-memo.com/dsh/latest.json"
