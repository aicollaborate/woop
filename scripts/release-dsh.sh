#!/usr/bin/env bash
# Build and optionally publish the standalone, headless Flowix DSH package.
#
# Local build:
#   bash scripts/release-dsh.sh
# Publish one or more prebuilt platform targets:
#   DSH_PUBLISH=1 FLOWIX_DSH_SKIP_BUILD=1 \
#   FLOWIX_DSH_TARGETS=node24-windows-x64 \
#   bash scripts/release-dsh.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${FLOWIX_DSH_VERSION:-$(node -p "require('./dsh-flowix-host/package.json').version")}"
OUT_DIR="${FLOWIX_DSH_RELEASE_OUT:-$REPO_ROOT/.build/releases/dsh}"
BUCKET="${FLOWIX_DSH_R2_BUCKET:-flowix-downloads}"
PREFIX="${FLOWIX_DSH_R2_PREFIX:-dsh/v${VERSION}}"

cd "$REPO_ROOT"
if [[ "${DSH_PUBLISH:-0}" == "1" ]]; then
  if [[ "${FLOWIX_DSH_SKIP_BUILD:-0}" != "1" ]]; then
    echo "release-dsh.sh: production publishing requires FLOWIX_DSH_SKIP_BUILD=1 and all prebuilt targets" >&2
    exit 1
  fi
fi
if [[ -z "${FLOWIX_DSH_TARGETS:-}" ]]; then
  FLOWIX_DSH_TARGETS="$(node -p "'node24-' + (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform) + '-' + (process.arch === 'arm64' ? 'arm64' : 'x64')")"
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

# Stable channels are platform-specific, matching Flowix's updater layout.
# A partial release updates only the covered platform channels.
declare -A PUBLISHED_GROUPS=()
for target in ${FLOWIX_DSH_TARGETS//,/ }; do
  case "$target" in
    node24-macos-*) group="macos" ;;
    node24-windows-*) group="windows" ;;
    node24-linux-*) group="linux" ;;
    *) echo "release-dsh.sh: unsupported target $target" >&2; exit 1 ;;
  esac
  manifest="$OUT_DIR/platforms/$group/latest.json"
  if [[ ! -f "$manifest" ]]; then
    echo "release-dsh.sh: platform manifest is missing: $manifest" >&2
    exit 1
  fi
  [[ -n "${PUBLISHED_GROUPS[$group]:-}" ]] && continue
  "$WRANGLER" r2 object put "$BUCKET/dsh/$group/latest.json" \
    --file "$manifest" --remote
  PUBLISHED_GROUPS[$group]=1
  echo "    manifest: https://download.flowix-memo.com/dsh/$group/latest.json"
done

echo "published DSH ${VERSION}"
