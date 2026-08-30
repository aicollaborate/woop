import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const outputRoot = resolve(repo, '.build/dsh-runtime-dev')
const target = targetKey()
const bundleRoot = resolve(outputRoot, target)
const manifest = JSON.parse(await readFile(resolve(repo, 'dsh/latest.json'), 'utf8'))
const appserver = resolve(repo, 'dsh-appserver')
const memory = resolve(repo, 'dsh-flowix-memory')
const artifact = manifest.platforms[manifestPlatform()]

if (!artifact?.url) throw new Error(`DSH dev runtime is unavailable for ${manifestPlatform()}`)
if (!existsSync(resolve(appserver, 'package.json'))) throw new Error('dsh-appserver/package.json is missing')
if (!existsSync(resolve(memory, 'package.json'))) throw new Error('dsh-flowix-memory/package.json is missing')

await rm(bundleRoot, { recursive: true, force: true })
await mkdir(bundleRoot, { recursive: true })
const archive = resolve(outputRoot, `${target}.tar.gz`)
const response = await fetch(artifact.url)
if (!response.ok) throw new Error(`download DSH dev runtime failed: ${response.status} ${response.statusText}`)
await writeFile(archive, Buffer.from(await response.arrayBuffer()))
run('tar', ['-xzf', archive, '-C', bundleRoot])
await rm(archive, { force: true })

const profile = resolve(bundleRoot, 'profile/flowix')
const devHome = resolve(bundleRoot, '.dev-dsh-home')
await mkdir(resolve(profile, 'node_modules'), { recursive: true })
await rm(resolve(profile, 'node_modules/@flowix'), { recursive: true, force: true })
await cp(appserver, resolve(profile, 'node_modules/dsh-appserver'), { recursive: true, filter: path => !path.includes('/node_modules/') })
await cp(memory, resolve(profile, 'node_modules/dsh-flowix-memory'), { recursive: true, filter: path => !path.includes('/node_modules/') })
await cp(resolve(repo, 'scripts/dsh-dev-profile.patch.yml'), resolve(profile, 'cordis.patch.yml'))
await writeFile(resolve(profile, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-flowix',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-appserver', 'dsh-flowix-memory'] } },
}, null, 2)}\n`)
await mkdir(resolve(devHome, 'profiles'), { recursive: true })
await cp(profile, resolve(devHome, 'profiles/flowix'), { recursive: true })

const metadata = JSON.parse(await readFile(resolve(bundleRoot, 'dsh-runtime.json'), 'utf8'))
metadata.devBuild = true
metadata.devSource = 'published-dsh-cli-carrier + local dsh-appserver'
metadata.profileBundles = ['@deepseek-ai/dsh-base', 'dsh-appserver', 'dsh-flowix-memory']
await writeFile(resolve(bundleRoot, 'dsh-runtime-dev.json'), `${JSON.stringify(metadata, null, 2)}\n`)

// Validate the profile with the same DSH CLI used by Desktop. This does not
// start an agent, manage plugins, or make a model request.
run(resolve(bundleRoot, 'node/node'), [
  resolve(bundleRoot, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  '--profile', 'flowix', '--dump-config',
], { DSH_HOME: devHome, DSH_PROFILE_DIR: profile })
console.log(`created DSH dev runtime: ${bundleRoot}`)

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: repo, env: { ...process.env, ...extraEnv }, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function targetKey() {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  return `node24-${platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
}
function manifestPlatform() {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'
  return `${platform}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
}
