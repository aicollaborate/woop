// Generate a single updater manifest for a release.
//
// Inputs (env vars):
//   FLOWIX_MANIFEST_OUT       output file path (overwritten if exists)
//   FLOWIX_VERSION            Flowix version this release advertises
//   FLOWIX_R2_PUBLIC_BASE     public origin for artifact URLs (no trailing slash)
//   FLOWIX_R2_PREFIX          R2 key prefix under which artifacts were uploaded
//   FLOWIX_HOME_DIR           path to the flowix-home checkout (used to read the
//                             previous combined manifest so lagging platforms
//                             survive in `x-flowix-installers`)
//   FLOWIX_RELEASE_OUT        artifact staging directory (rows' `.sig` files
//                             are read from here)
//
// Inputs (positional argv):
//   <platform>|<artifact-name>   one per built target. Multiple rows may share
//                                the same `platform` (e.g. darwin-aarch64 and
//                                darwin-x86_64 both belong to the macos group).
//
// `platforms` only ever contains the rows we received. This is what makes
// partial releases safe: each platform's updater hits a manifest whose top-
// level `version` matches the artifact's actual version, so Tauri never
// advertises a newer version than the binary the user will actually download.

import fs from 'node:fs';
import path from 'node:path';

const out = process.env.FLOWIX_MANIFEST_OUT;
const version = process.env.FLOWIX_VERSION;
const publicBase = process.env.FLOWIX_R2_PUBLIC_BASE?.replace(/\/$/u, '');
const prefix = process.env.FLOWIX_R2_PREFIX?.replace(/^\/+|\/+$/gu, '');
const homeDir = process.env.FLOWIX_HOME_DIR;
const releaseOut = process.env.FLOWIX_RELEASE_OUT;
const rows = process.argv.slice(1);

if (!out || !version || !publicBase || prefix === undefined || !releaseOut) {
  throw new Error('build-updater-manifest: FLOWIX_MANIFEST_OUT, FLOWIX_VERSION, FLOWIX_R2_PUBLIC_BASE, FLOWIX_R2_PREFIX, and FLOWIX_RELEASE_OUT are required');
}

const platforms = {};
for (const row of rows) {
  const separator = row.indexOf('|');
  if (separator < 0) continue;
  const platform = row.slice(0, separator);
  const name = row.slice(separator + 1);
  const signature = fs.readFileSync(path.join(releaseOut, `${name}.sig`), 'utf8').trim();
  platforms[platform] = {
    signature,
    url: `${publicBase}/${prefix}/${name}`,
  };
}

// x-flowix-installers: 官网下载弹窗专用扩展块, Tauri updater 忽略未知字段。
// macOS 行优先用营销命名的 DMG（与 .app.tar.gz 同前缀），保持官网下载链接稳定。
const installers = {};
const DMG_TRIPLES = {
  'darwin-aarch64': ['aarch64-apple-darwin', `Flowix-${version}-macOS-Apple-Silicon.dmg`],
  'darwin-x86_64': ['x86_64-apple-darwin', `Flowix-${version}-macOS-Intel.dmg`],
};
for (const platform of Object.keys(platforms)) {
  const entry = {
    version,
    url: platforms[platform].url,
    sizeBytes: fs.statSync(path.join(releaseOut, rows.find(r => r.startsWith(`${platform}|`)).split('|')[1])).size,
  };
  const dmg = DMG_TRIPLES[platform];
  if (dmg) {
    entry.url = `${publicBase}/${prefix}/${dmg[1]}`;
    const localDmg = path.join(process.env.CARGO_TARGET_DIR || '', dmg[0], 'release', 'bundle', 'dmg');
    try {
      const found = fs.readdirSync(localDmg).find(f => f.endsWith('.dmg'));
      if (found) entry.sizeBytes = fs.statSync(path.join(localDmg, found)).size;
    } catch (_) { /* DMG 不在本机时保留 updater 产物大小 */ }
  }
  installers[platform] = entry;
}

// 滞后平台结转: 仅 combined manifest 才读取上一版 site manifest 来回填。
// per-platform manifest 不做结转 —— 该平台没在这次发布就根本没有 manifest 行。
if (homeDir) {
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(homeDir, 'src', 'latest.json'), 'utf8'));
    for (const [platform, entry] of Object.entries(previous['x-flowix-installers'] || {})) {
      if (!installers[platform] && entry && typeof entry.url === 'string') {
        installers[platform] = entry;
      }
    }
  } catch (_) { /* 首次发布或无上一版 manifest */ }
}

const manifest = {
  version,
  notes: `Flowix ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
  'x-flowix-installers': installers,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`==> wrote ${path.relative(process.cwd(), out)}`);
