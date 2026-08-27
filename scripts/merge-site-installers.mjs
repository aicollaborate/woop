// Merge the shipped groups' x-flowix-installers entries into the site manifest.
//
// Used by release.sh on PARTIAL releases: `version`/`platforms` in the site
// manifest are the legacy updater surface for already-shipped clients and are
// only regenerated on full releases, but the website download dialog reads
// x-flowix-installers — merging keeps it in sync with whatever just shipped.
//
// Inputs (env):
//   FLOWIX_HOME_MANIFEST   path to flowix-home/src/latest.json (modified in place)
//   FLOWIX_RELEASE_OUT     release staging dir containing updater/<group>/latest.json
//   ACTIVE_GROUPS_STR      space-separated groups shipped in this release

import fs from 'node:fs';

const sitePath = process.env.FLOWIX_HOME_MANIFEST;
const releaseOut = process.env.FLOWIX_RELEASE_OUT;
const groups = (process.env.ACTIVE_GROUPS_STR || '').split(/\s+/u).filter(Boolean);

if (!sitePath || !releaseOut || groups.length === 0) {
  throw new Error('merge-site-installers: FLOWIX_HOME_MANIFEST, FLOWIX_RELEASE_OUT and ACTIVE_GROUPS_STR are required');
}
if (!fs.existsSync(sitePath)) {
  throw new Error(`merge-site-installers: site manifest not found at ${sitePath}; run a full release first`);
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

fs.writeFileSync(sitePath, `${JSON.stringify(site, null, 2)}\n`);
console.log(`merge-site-installers: merged ${merged} entr${merged === 1 ? 'y' : 'ies'} for ${groups.join(', ')}`);
