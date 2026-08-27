// Merge the shipped groups' x-flowix-installers entries into the site manifest.
//
// Used by release.sh on PARTIAL releases: `version`/`platforms` in the site
// manifest are the legacy updater surface for already-shipped clients and are
// only regenerated on full releases, but the website download dialog reads
// x-flowix-installers — merging keeps it in sync with whatever just shipped.
//
// FLOWIX_MIGRATE_LEGACY=1 additionally advances the site manifest's
// `version`/`platforms` to this release (never regressing). This is the
// one-shot migration bridge: legacy clients (whose baked endpoint is the root
// /latest.json) update once to a build that carries the per-platform updater
// endpoint and leave the legacy surface forever. Set the flag on a release,
// then leave it off — the frozen manifest keeps serving late stragglers.
//
// Inputs (env):
//   FLOWIX_HOME_MANIFEST   path to flowix-home/src/latest.json (modified in place)
//   FLOWIX_RELEASE_OUT     release staging dir containing updater/<group>/latest.json
//   ACTIVE_GROUPS_STR      space-separated groups shipped in this release
//   FLOWIX_MIGRATE_LEGACY  set to 1 to advance version/platforms (opt-in)

import fs from 'node:fs';

const sitePath = process.env.FLOWIX_HOME_MANIFEST;
const releaseOut = process.env.FLOWIX_RELEASE_OUT;
const groups = (process.env.ACTIVE_GROUPS_STR || '').split(/\s+/u).filter(Boolean);
const migrateLegacy = process.env.FLOWIX_MIGRATE_LEGACY === '1';

if (!sitePath || !releaseOut || groups.length === 0) {
  throw new Error('merge-site-installers: FLOWIX_HOME_MANIFEST, FLOWIX_RELEASE_OUT and ACTIVE_GROUPS_STR are required');
}
if (!fs.existsSync(sitePath)) {
  throw new Error(`merge-site-installers: site manifest not found at ${sitePath}; run a full release first`);
}

function versionSegments(version) {
  return String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function isGreaterVersion(a, b) {
  const A = versionSegments(a);
  const B = versionSegments(b);
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

const site = JSON.parse(fs.readFileSync(sitePath, 'utf8'));
site['x-flowix-installers'] ??= {};

let merged = 0;
for (const group of groups) {
  const groupManifest = JSON.parse(fs.readFileSync(`${releaseOut}/updater/${group}/latest.json`, 'utf8'));
  for (const [platform, entry] of Object.entries(groupManifest['x-flowix-installers'] || {})) {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') continue;
    site['x-flowix-installers'][platform] = entry;
    merged += 1;
  }
}

if (migrateLegacy) {
  const groupManifests = groups.map((group) => (
    JSON.parse(fs.readFileSync(`${releaseOut}/updater/${group}/latest.json`, 'utf8'))
  ));
  // 所有 group 的 version 相同(同一次发布); 不相同时拒绝, 防止把低版本平台的
  // entry 提升到高 version 下发(会触发存量客户端无限重装)。
  const releaseVersion = groupManifests[0].version;
  if (!groupManifests.every((m) => m.version === releaseVersion)) {
    throw new Error(`merge-site-installers: inconsistent group versions: ${groupManifests.map((m) => m.version).join(', ')}`);
  }
  if (isGreaterVersion(releaseVersion, site.version)) {
    site.version = releaseVersion;
    site.notes = `Flowix ${releaseVersion}`;
    site.pub_date = new Date().toISOString();
    site.platforms = Object.assign({}, ...groupManifests.map((m) => m.platforms));
    console.log(`merge-site-installers: legacy surface migrated to ${releaseVersion} (platforms: ${Object.keys(site.platforms).join(', ')})`);
  } else {
    console.log(`merge-site-installers: legacy migration skipped, ${releaseVersion} <= site ${site.version}`);
  }
}

fs.writeFileSync(sitePath, `${JSON.stringify(site, null, 2)}\n`);
console.log(`merge-site-installers: merged ${merged} entr${merged === 1 ? 'y' : 'ies'} for ${groups.join(', ')}`);
