import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const releaseDir = resolve(process.env.FLOWIX_DSH_RELEASE_DIR ?? resolve(repo, '.build/releases/dsh'))
const manifestPath = resolve(process.env.FLOWIX_DSH_MANIFEST ?? resolve(releaseDir, 'platforms/macos/latest.json'))
const bucket = process.env.FLOWIX_DSH_R2_BUCKET ?? 'flowix-downloads'
const objectPrefix = process.env.FLOWIX_DSH_R2_PREFIX ?? 'dsh'
const channel = process.env.FLOWIX_DSH_CHANNEL ?? 'macos'
const publicBase = (process.env.FLOWIX_DSH_PUBLIC_BASE ?? 'https://download.flowix-memo.com').replace(/\/$/u, '')
const wrangler = process.env.WRANGLER ?? 'wrangler'

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.product !== 'flowix-dsh' || !manifest.version || !manifest.platforms) {
  throw new Error(`invalid DSH release manifest: ${manifestPath}`)
}
const version = manifest.version
const artifacts = []
for (const [platform, artifact] of Object.entries(manifest.platforms)) {
  if (!artifact || typeof artifact.url !== 'string' || typeof artifact.sha256 !== 'string') {
    throw new Error(`invalid artifact entry for ${platform}`)
  }
  const filename = basename(new URL(artifact.url).pathname)
  const archive = resolve(releaseDir, filename)
  const signature = `${archive}.sig`
  if (!existsSync(archive) || !existsSync(signature)) throw new Error(`missing local DSH artifact or signature for ${platform}: ${filename}`)
  const bytes = await readFile(archive)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== artifact.sha256.toLowerCase()) throw new Error(`local checksum mismatch for ${filename}`)
  if (artifact.sizeBytes !== undefined && artifact.sizeBytes !== bytes.length) throw new Error(`local size mismatch for ${filename}`)
  const signatureText = (await readFile(signature, 'utf8')).trim()
  if (!signatureText || signatureText !== artifact.signature?.trim()) throw new Error(`manifest signature mismatch for ${filename}`)
  artifacts.push({ platform, artifact, filename, archive, signature })
}

// The versioned prefix is immutable. Publish every artifact and its sidecar
// before touching the stable manifest consumed by installed Flowix clients.
for (const item of artifacts) {
  put(`${objectPrefix}/${version}/${item.filename}`, item.archive)
  put(`${objectPrefix}/${version}/${item.filename}.sig`, item.signature)
}

for (const item of artifacts) await verifyRemoteArtifact(item.artifact, item.filename)

const stableKey = `${objectPrefix}/${channel}/latest.json`
put(stableKey, manifestPath)
const stableUrl = `${publicBase}/${stableKey}`
const remote = await fetchJson(`${stableUrl}?dsh-release=${encodeURIComponent(version)}`)
if (JSON.stringify(remote) !== JSON.stringify(manifest)) {
  throw new Error(`published DSH manifest does not match local manifest: ${stableUrl}`)
}
for (const item of artifacts) await verifyRemoteArtifact(item.artifact, item.filename)
console.log(`published DSH ${version} to ${stableUrl}`)

async function verifyRemoteArtifact(artifact, filename) {
  const response = await fetch(artifact.url, { cache: 'no-store' })
  if (!response.ok || !response.body) throw new Error(`download verification failed for ${filename}: HTTP ${response.status}`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    hash.update(chunk)
    size += chunk.length
  }
  if (hash.digest('hex') !== artifact.sha256.toLowerCase()) throw new Error(`public checksum mismatch for ${filename}`)
  if (artifact.sizeBytes !== undefined && size !== artifact.sizeBytes) throw new Error(`public size mismatch for ${filename}: ${size}`)
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`manifest verification failed: HTTP ${response.status}`)
  return response.json()
}

function put(key, file) {
  const result = spawnSync(wrangler, ['r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--remote'], {
    cwd: repo,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`wrangler upload failed for ${key}`)
}
