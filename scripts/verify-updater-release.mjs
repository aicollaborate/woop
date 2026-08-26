import fs from 'node:fs';
import path from 'node:path';

const [manifestPath, expectedVersion, expectedPrefixArg, ...requiredPlatforms] = process.argv.slice(2);

if (!manifestPath || !expectedVersion || !expectedPrefixArg || requiredPlatforms.length === 0) {
  console.error('Usage: node scripts/verify-updater-release.mjs <latest.json> <version> <prefix> <platform...>');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const releaseDir = path.dirname(path.resolve(manifestPath));

if (manifest.version !== expectedVersion) {
  throw new Error(`manifest version mismatch: expected ${expectedVersion}, got ${manifest.version ?? '<missing>'}`);
}
if (!manifest.pub_date || Number.isNaN(Date.parse(manifest.pub_date))) {
  throw new Error('manifest pub_date is missing or invalid');
}
if (!manifest.platforms || typeof manifest.platforms !== 'object' || Array.isArray(manifest.platforms)) {
  throw new Error('manifest platforms must be an object');
}

const expectedPrefix = expectedPrefixArg.replace(/^\/+|\/+$/gu, '');
for (const platform of requiredPlatforms) {
  const entry = manifest.platforms[platform];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`manifest is missing required platform ${platform}`);
  }
  if (typeof entry.signature !== 'string' || !entry.signature.trim()) {
    throw new Error(`manifest signature is missing for ${platform}`);
  }
  if (typeof entry.url !== 'string' || !entry.url.trim()) {
    throw new Error(`manifest URL is missing for ${platform}`);
  }

  const url = new URL(entry.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const normalizedPath = `/${segments.join('/')}/`;
  if (!normalizedPath.includes(`/${expectedPrefix}/`)) {
    throw new Error(`manifest URL for ${platform} does not point to ${expectedPrefix}`);
  }

  const artifactName = decodeURIComponent(segments.at(-1) ?? '');
  if (!artifactName || path.basename(artifactName) !== artifactName) {
    throw new Error(`manifest URL for ${platform} has an invalid artifact name`);
  }
  for (const fileName of [artifactName, `${artifactName}.sig`]) {
    if (!fs.statSync(path.join(releaseDir, fileName), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`release file is missing for ${platform}: ${fileName}`);
    }
  }
  const signatureFile = fs.readFileSync(path.join(releaseDir, `${artifactName}.sig`), 'utf8').trim();
  if (entry.signature.trim() !== signatureFile) {
    throw new Error(`manifest signature does not match ${artifactName}.sig for ${platform}`);
  }
}

const unexpectedPlatforms = Object.keys(manifest.platforms).filter(
  (platform) => !requiredPlatforms.includes(platform),
);
if (unexpectedPlatforms.length > 0) {
  throw new Error(`manifest contains platforms outside this build: ${unexpectedPlatforms.join(', ')}`);
}

// 官网扩展块(Tauri updater 忽略):可选,但存在时必须形状正确;
// 与本次 platforms 重叠的条目版本必须一致,滞后平台则要求自带 version。
const installers = manifest['x-flowix-installers'];
if (installers !== undefined) {
  if (!installers || typeof installers !== 'object' || Array.isArray(installers)) {
    throw new Error('x-flowix-installers must be an object when present');
  }
  for (const [platform, entry] of Object.entries(installers)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`x-flowix-installers entry is invalid for ${platform}`);
    }
    if (typeof entry.url !== 'string' || !entry.url.trim()) {
      throw new Error(`x-flowix-installers URL is missing for ${platform}`);
    }
    if (platform in manifest.platforms) {
      if (entry.version !== manifest.version) {
        throw new Error(`x-flowix-installers version for ${platform} must match the release version`);
      }
    } else if (typeof entry.version !== 'string' || !/^\d+(\.\d+){1,3}$/u.test(entry.version)) {
      throw new Error(`x-flowix-installers carries lagging platform ${platform} without a valid version`);
    }
  }
}

console.log(`verified updater manifest ${manifest.version}: ${requiredPlatforms.join(', ')}`);
