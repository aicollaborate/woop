import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const version = process.env.FLOWIX_DSH_VERSION || 'dsh.01'
if (!/^dsh\.(?:0[1-9]|[1-9][0-9]*)$/u.test(version)) {
  throw new Error(`invalid DSH package version ${version}; expected dsh.01, dsh.02, ...`)
}
const sourceManifestUrl = process.env.FLOWIX_DSH_SOURCE_MANIFEST || 'https://download.flowix-memo.com/dsh/macos/latest.json'
const out = resolve(repo, '.build/releases/dsh')
const stage = resolve(repo, '.build/dsh-prod-stage')
const manifest = await (await fetch(sourceManifestUrl)).json()
if (!manifest.platforms) throw new Error(`invalid DSH source manifest: ${sourceManifestUrl}`)

await rm(out, { recursive: true, force: true })
await rm(stage, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const platforms = {}

for (const target of ['node24-macos-arm64', 'node24-macos-x64']) {
  const platform = target.endsWith('arm64') ? 'darwin-aarch64' : 'darwin-x86_64'
  const source = manifest.platforms[platform]
  if (!source?.url) throw new Error(`source DSH artifact missing for ${platform}`)
  const targetRoot = resolve(stage, target)
  await mkdir(targetRoot, { recursive: true })
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`download DSH carrier failed: ${response.status}`)
  const archive = resolve(stage, `${target}.tar.gz`)
  await writeFile(archive, Buffer.from(await response.arrayBuffer()))
  run('tar', ['-xzf', archive, '-C', targetRoot])
  await rm(archive, { force: true })

  const profile = resolve(targetRoot, 'profile/flowix')
  await mkdir(resolve(profile, 'node_modules'), { recursive: true })
  await cp(resolve(repo, 'dsh-appserver'), resolve(profile, 'node_modules/dsh-appserver'), { recursive: true, filter: p => !p.includes('/node_modules/') })
  await cp(resolve(repo, 'dsh-flowix-memory'), resolve(profile, 'node_modules/dsh-flowix-memory'), { recursive: true, filter: p => !p.includes('/node_modules/') })
  await cp(resolve(repo, 'scripts/dsh-dev-profile.patch.yml'), resolve(profile, 'cordis.patch.yml'))
  await writeFile(resolve(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-flowix', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-appserver', 'dsh-flowix-memory'] } },
  }, null, 2)}\n`)
  await rm(resolve(targetRoot, 'host'), { recursive: true, force: true })
  await rm(resolve(targetRoot, 'dsh-runtime-dev.json'), { force: true })
  await rm(resolve(targetRoot, '.dev-dsh-home'), { recursive: true, force: true })

  const metadata = JSON.parse(await readFile(resolve(targetRoot, 'dsh-runtime.json'), 'utf8'))
  metadata.version = version
  metadata.entrypoint = 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'
  metadata.cliEntrypoint = metadata.entrypoint
  metadata.buildId = createHash('sha256').update(`${version}:${target}:${JSON.stringify(metadata)}:${Date.now()}`).digest('hex').slice(0, 24)
  await writeFile(resolve(targetRoot, 'dsh-runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`)

  const healthHome = resolve(targetRoot, '.health-home')
  await mkdir(resolve(healthHome, 'profiles'), { recursive: true })
  await cp(profile, resolve(healthHome, 'profiles/flowix'), { recursive: true })
  run(resolve(targetRoot, 'node/node'), [resolve(targetRoot, metadata.entrypoint), '--profile', 'flowix', '--dump-config'], {
    DSH_HOME: healthHome,
    DSH_PROFILE_DIR: profile,
  })
  await rm(healthHome, { recursive: true, force: true })
  const filename = `Flowix-DSH_${version}_${target}.tar.gz`
  const archivePath = resolve(out, filename)
  run('tar', ['-czf', archivePath, '-C', targetRoot, '.'])
  const bytes = await readFile(archivePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  platforms[platform] = {
    url: `https://download.flowix-memo.com/dsh/${version}/${filename}?sha256=${sha256}`,
    sha256, sizeBytes: bytes.length, buildId: metadata.buildId,
  }
  console.log(`created ${archivePath} (${sha256})`)
}

const output = { schemaVersion: 1, product: 'flowix-dsh', version, protocolVersion: 1, minFlowixVersion: '1.2.9', platforms }
await writeFile(resolve(out, 'dsh-latest.json'), `${JSON.stringify(output, null, 2)}\n`)
await mkdir(resolve(out, 'platforms/macos'), { recursive: true })
await writeFile(resolve(out, 'platforms/macos/latest.json'), `${JSON.stringify(output, null, 2)}\n`)
console.log(`created ${resolve(out, 'dsh-latest.json')}`)

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: repo, env: { ...process.env, ...extraEnv }, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
