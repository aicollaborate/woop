#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

const output = process.argv[2]
const requiredPlatforms = process.argv
  .find((argument) => argument.startsWith('--require-platforms='))
  ?.slice('--require-platforms='.length)
  .split(',')
  .map((platform) => platform.trim())
  .filter(Boolean) ?? []
const inputs = process.argv.slice(3).filter((argument) => !argument.startsWith('--require-platforms='))
if (!output || inputs.length === 0) {
  console.error('usage: node scripts/merge-dsh-manifests.mjs <output> <manifest...>')
  process.exit(2)
}

const manifests = await Promise.all(inputs.map(async (file) => JSON.parse(await readFile(file, 'utf8'))))
const first = manifests[0]
const platforms = {}

for (const manifest of manifests) {
  for (const field of ['schemaVersion', 'product', 'version', 'protocolVersion', 'minFlowixVersion']) {
    if (manifest[field] !== first[field]) {
      throw new Error(`${field} differs between DSH manifests`)
    }
  }
  for (const [platform, artifact] of Object.entries(manifest.platforms ?? {})) {
    if (platforms[platform]) throw new Error(`duplicate DSH platform: ${platform}`)
    platforms[platform] = artifact
  }
}

if (Object.keys(platforms).length === 0) throw new Error('merged DSH manifest has no platforms')
const missingPlatforms = requiredPlatforms.filter((platform) => !platforms[platform])
if (missingPlatforms.length > 0) {
  throw new Error(`merged DSH manifest is missing platforms: ${missingPlatforms.join(', ')}`)
}
await writeFile(output, `${JSON.stringify({ ...first, platforms }, null, 2)}\n`)
console.log(`merged ${Object.keys(platforms).length} DSH platforms into ${output}`)
