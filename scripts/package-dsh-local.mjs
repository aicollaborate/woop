import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { createDshRuntimeMetadata } from './dsh-runtime-metadata.mjs'

const repo = resolve(import.meta.dirname, '..')
const upstream = resolve(repo, '.build/upstream/deepseek-harness')
const output = resolve(repo, '.build/dsh-local-package')
const bundle = resolve(output, 'node24-windows-x64')
const runtime = resolve(output, 'runtime')
const release = resolve(repo, '.build/releases/dsh-local')
const version = process.env.FLOWIX_DSH_VERSION || '1.1.0'
const minFlowixVersion = process.env.FLOWIX_VERSION || '1.3.0'
const semverPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

if (!semverPattern.test(version)) {
  throw new Error(`invalid DSH package version ${version}; expected SemVer such as 1.1.0`)
}
if (!semverPattern.test(minFlowixVersion)) {
  throw new Error(`invalid minimum Flowix version ${minFlowixVersion}; expected SemVer such as 1.2.6`)
}
if (!existsSync(resolve(upstream, 'package.json'))) {
  throw new Error(`local DSH upstream source is missing: ${upstream}`)
}

await rm(output, { recursive: true, force: true })
await rm(release, { recursive: true, force: true })
await mkdir(runtime, { recursive: true })

run(process.execPath, [
  resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js'),
  'pnpm@11.7.0', '--dir', upstream, '--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', '--prod',
  '--config.node-linker=hoisted', '--config.auto-install-peers=false', runtime,
])

for (const entry of await readdir(resolve(upstream, 'vendor'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const packageRoot = resolve(upstream, 'vendor', entry.name)
  const packageJson = resolve(packageRoot, 'package.json')
  if (!existsSync(packageJson)) continue
  const packageName = JSON.parse(await readFile(packageJson, 'utf8')).name
  if (typeof packageName === 'string' && packageName.length > 0) {
    const destination = resolve(runtime, 'node_modules', ...packageName.split('/'))
    await rm(destination, { recursive: true, force: true })
    await copyTree(packageRoot, destination)
  }
}

await mkdir(bundle, { recursive: true })
await cp(runtime, resolve(bundle, 'runtime'), { recursive: true, force: true })
await mkdir(resolve(bundle, 'node'), { recursive: true })
await cp(process.execPath, resolve(bundle, 'node/node.exe'))
await copyTree(resolve(repo, 'dsh-appserver'), resolve(bundle, 'profile/flowix/node_modules/dsh-appserver'))
await copyTree(resolve(repo, 'dsh-flowix-memory'), resolve(bundle, 'profile/flowix/node_modules/dsh-flowix-memory'))
await mkdir(resolve(bundle, 'profile/flowix'), { recursive: true })
await writeFile(resolve(bundle, 'profile/flowix/package.json'), `${JSON.stringify({
  name: 'dsh-profile-flowix',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-appserver', 'dsh-flowix-memory'] } },
}, null, 2)}\n`)
await cp(resolve(repo, 'scripts/dsh-dev-profile.patch.yml'), resolve(bundle, 'profile/flowix/cordis.patch.yml'))

const metadata = createDshRuntimeMetadata({
  target: 'node24-windows-x64',
  version,
  nodeExecutable: 'node/node.exe',
  nodeVersion: process.version,
  nodeAbi: process.versions.modules,
  includePnpm: false,
  localBuild: true,
})
await writeFile(resolve(bundle, 'dsh-runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`)

const profile = resolve(bundle, 'profile/flowix')
const healthHome = resolve(output, '.health-dsh-home')
await mkdir(resolve(healthHome, 'profiles'), { recursive: true })
await cp(profile, resolve(healthHome, 'profiles/flowix'), { recursive: true, force: true })
run(process.execPath, [resolve(bundle, metadata.entrypoint), '--profile', 'flowix', '--dump-config'], {
  DSH_HOME: healthHome,
  DSH_PROFILE_DIR: profile,
  FLOWIX_DSH_ROOT: bundle,
})

await mkdir(release, { recursive: true })
const filename = `Flowix-DSH_${version}_node24-windows-x64.tar.gz`
const archive = resolve(release, filename)
run('tar', ['-czf', relative(repo, archive), '-C', bundle, '.'])
const bytes = await readFile(archive)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const signature = signUpdaterArtifact(archive)
const manifest = {
  schemaVersion: 1,
  product: 'flowix-dsh',
  version,
  protocolVersion: 1,
  minFlowixVersion,
  platforms: {
    'windows-x86_64': {
      url: `https://download.flowix-memo.com/dsh/${version}/${filename}?sha256=${sha256}`,
      sha256,
      signature,
      sizeBytes: bytes.length,
      buildId: metadata.buildId,
    },
  },
}
await mkdir(resolve(release, 'platforms/windows'), { recursive: true })
await writeFile(resolve(release, 'platforms/windows/latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(resolve(release, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`created ${archive}`)
console.log(`sha256 ${sha256}`)

async function copyTree(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
    filter: value => !value.split(/[\\/]/u).includes('node_modules'),
  })
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: repo, env: { ...process.env, ...extraEnv }, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function signUpdaterArtifact(file) {
  const signer = resolve(repo, 'scripts/sign-updater-artifact.mjs')
  const result = spawnSync(process.execPath, [signer, file], {
    cwd: repo,
    env: process.env,
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout.trim()
}
