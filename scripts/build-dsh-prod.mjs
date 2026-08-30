import { spawn } from 'node:child_process'
import { chmod, cp, lstat, mkdir, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`DSH production bundles require Node 24; current runtime is ${process.version}`)
}

const repo = resolve(import.meta.dirname, '..')
const upstream = resolve(repo, '.build/upstream/deepseek-harness')
const target = process.argv.find(value => value.startsWith('--target='))?.slice(9) ?? hostTarget()
if (!/^node24-macos-(?:x64|arm64)$/.test(target)) throw new Error(`unsupported DSH target: ${target}`)
if (target !== hostTarget()) {
  throw new Error(`target ${target} must match the active Node runtime ${hostTarget()}; use Rosetta for x64 on Apple Silicon`)
}
if (!existsSync(resolve(upstream, 'package.json'))) {
  throw new Error(`local DSH source is missing: ${upstream}`)
}

process.env.CI = 'true'
process.env.NODE_ENV = 'development'
const bundle = resolve(repo, '.build/dsh-runtime-bundle', target)
const runtime = resolve(bundle, 'runtime')
const pnpmVersion = '11.7.0'

if (!existsSync(resolve(upstream, 'node_modules/.modules.yaml'))) {
  await run(corepack(), ['pnpm@' + pnpmVersion, 'install', '--frozen-lockfile', '--prod=false'], upstream)
}
const markers = [resolve(upstream, 'apps/cli/lib/bin.js')]
if (!markers.every(existsSync) || process.env.FLOWIX_DSH_REBUILD_LIBS === '1') {
  await run(corepack(), ['pnpm@' + pnpmVersion, 'run', 'build:lib:host'], upstream)
}
await rm(bundle, { recursive: true, force: true })
await mkdir(bundle, { recursive: true })
await run(corepack(), [
  'pnpm@' + pnpmVersion, '--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', '--prod',
  '--config.node-linker=hoisted', '--config.auto-install-peers=false', runtime,
], upstream)
await materializeLinks(resolve(runtime, 'node_modules'))
await materializeWorkspaceRoots(runtime, upstream)
await rm(resolve(runtime, 'src'), { recursive: true, force: true })
await copyTree(resolve(upstream, 'apps/cli'), resolve(runtime, 'node_modules/@deepseek-ai/dsh'))
await copyTree(resolve(repo, 'dsh-appserver'), resolve(runtime, 'node_modules/dsh-appserver'), true)
await copyTree(resolve(repo, 'dsh-flowix-memory'), resolve(runtime, 'node_modules/dsh-flowix-memory'), true)

const profile = resolve(bundle, 'profile/flowix')
await mkdir(resolve(profile, 'node_modules'), { recursive: true })
await copyTree(resolve(repo, 'dsh-appserver'), resolve(profile, 'node_modules/dsh-appserver'), true)
await copyTree(resolve(repo, 'dsh-flowix-memory'), resolve(profile, 'node_modules/dsh-flowix-memory'), true)
await cp(resolve(repo, 'scripts/dsh-dev-profile.patch.yml'), resolve(profile, 'cordis.patch.yml'))
await writeFile(resolve(profile, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-flowix', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-appserver', 'dsh-flowix-memory'] } },
}, null, 2)}\n`)

await mkdir(resolve(bundle, 'node'), { recursive: true })
const nodePath = resolve(bundle, 'node/node')
await cp(process.execPath, nodePath)
await optimizeMacosBundle(bundle, target, nodePath)
await installPrivatePnpm(bundle)
await writeFile(resolve(bundle, 'runtime-build.json'), `${JSON.stringify({
  target, nodeVersion: process.version, nodeAbi: process.versions.modules, pnpmVersion,
}, null, 2)}\n`)
console.log(`created local DSH runtime bundle: ${bundle}`)

function hostTarget() {
  return `node24-macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
}
function corepack() { return 'corepack' }
async function optimizeMacosBundle(root, runtimeTarget, nodePath) {
  const arch = runtimeTarget.endsWith('-arm64') ? 'arm64' : 'x86_64'
  const thin = `${nodePath}.thin`
  await run('lipo', ['-thin', arch, nodePath, '-output', thin], repo)
  await rm(nodePath, { force: true })
  await cp(thin, nodePath)
  await rm(thin, { force: true })
  const prebuilds = resolve(root, 'runtime/node_modules/node-pty/prebuilds')
  const keep = runtimeTarget.endsWith('-arm64') ? 'darwin-arm64' : 'darwin-x64'
  if (existsSync(prebuilds)) for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== keep) await rm(resolve(prebuilds, entry.name), { recursive: true, force: true })
  }
  await rm(resolve(root, 'runtime/node_modules/node-pty/third_party'), { recursive: true, force: true })
}
async function installPrivatePnpm(root) {
  const toolRoot = resolve(root, 'tools/pnpm')
  await mkdir(toolRoot, { recursive: true })
  await writeFile(resolve(toolRoot, 'package.json'), `${JSON.stringify({
    name: 'flowix-dsh-private-tools', private: true, dependencies: { pnpm: pnpmVersion },
  }, null, 2)}\n`)
  await run(corepack(), [
    'pnpm@' + pnpmVersion, '--dir', toolRoot, '--ignore-workspace', 'install', '--prod', '--ignore-scripts',
    '--config.manage-package-manager-versions=false', '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
  ], repo)
  await materializeLinks(resolve(toolRoot, 'node_modules'))
  const entrypoint = resolve(toolRoot, 'node_modules/pnpm/bin/pnpm.mjs')
  if (!existsSync(entrypoint)) throw new Error(`private pnpm entrypoint was not installed: ${entrypoint}`)
}
async function copyTree(source, destination, skipNodeModules = false) {
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (skipNodeModules && entry.name === 'node_modules') continue
    const from = resolve(source, entry.name)
    const to = resolve(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to, skipNodeModules)
    else if (entry.isFile()) await cp(from, to, { force: true })
  }
}
async function materializeLinks(directory) {
  if (!existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      const source = resolve(dirname(path), await readlink(path))
      if (!existsSync(source)) { await rm(path, { force: true }); continue }
      await rm(path, { recursive: true, force: true })
      const sourceInfo = await lstat(source)
      if (sourceInfo.isDirectory()) await copyTree(source, path)
      else await cp(source, path, { force: true })
    } else if (info.isDirectory()) await materializeLinks(path)
  }
}
async function materializeWorkspaceRoots(runtimeRoot, workspaceRoot) {
  const manifest = JSON.parse(await readFile(resolve(workspaceRoot, 'python/sdk-runtime/package.json'), 'utf8'))
  const packages = new Map()
  for (const root of ['apps', 'packages', 'vendor']) await indexPackages(resolve(workspaceRoot, root), packages)
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const destination = resolve(runtimeRoot, 'node_modules', ...name.split('/'))
    if (existsSync(resolve(destination, 'package.json'))) continue
    const source = packages.get(name)
    if (source === undefined) throw new Error(`workspace dependency ${name} was not materialized by pnpm deploy`)
    await copyTree(source, destination)
  }
}
async function indexPackages(directory, packages) {
  if (!existsSync(directory)) return
  const manifest = resolve(directory, 'package.json')
  if (existsSync(manifest)) {
    const value = JSON.parse(await readFile(manifest, 'utf8'))
    if (typeof value.name === 'string') packages.set(value.name, directory)
    return
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      await indexPackages(resolve(directory, entry.name), packages)
    }
  }
}
async function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(' ')}`)
  const child = spawn(command, args, { cwd, env: { ...process.env }, stdio: 'inherit' })
  const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', resolveCode) })
  if (code !== 0) throw new Error(`${command} exited with ${code}`)
}
