import { cp, lstat, mkdir, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { repairDshNativePackages, verifyDshNativePackages } from './dsh-native-deps.mjs'

if (process.platform !== 'win32') throw new Error('Windows DSH production bundles must be built on Windows')
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`DSH production bundles require Node 24; current runtime is ${process.version}`)
}
if (process.arch !== 'x64') throw new Error(`unsupported Windows DSH architecture: ${process.arch}`)

const repo = resolve(import.meta.dirname, '..')
process.env.FLOWIX_DSH_REQUIRE_PINNED = '1'
await import('./ensure-dsh-upstream.mjs')
const upstream = resolve(repo, '.build/upstream/deepseek-harness')
const target = 'node24-windows-x64'
const bundle = resolve(repo, '.build/dsh-runtime-bundle', target)
const runtime = resolve(bundle, 'runtime')
const profile = resolve(bundle, 'profile/flowix')
const pnpmVersion = '11.7.0'
const corepack = resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js')

process.env.CI = 'true'
process.env.NODE_ENV = 'development'
if (!existsSync(resolve(upstream, 'package.json'))) throw new Error(`local DSH source is missing: ${upstream}`)

if (!existsSync(resolve(upstream, 'node_modules/.modules.yaml'))) {
  await run(process.execPath, [corepack, `pnpm@${pnpmVersion}`, 'install', '--frozen-lockfile', '--prod=false'], upstream)
}
const cliMarker = resolve(upstream, 'apps/cli/lib/bin.js')
if (!existsSync(cliMarker) || process.env.FLOWIX_DSH_REBUILD_LIBS === '1') {
  await run(process.execPath, [corepack, `pnpm@${pnpmVersion}`, 'run', 'build:lib:host'], upstream)
}

await rm(bundle, { recursive: true, force: true })
await mkdir(bundle, { recursive: true })
await run(process.execPath, [
  corepack, `pnpm@${pnpmVersion}`, '--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', '--prod',
  '--config.node-linker=hoisted', '--config.auto-install-peers=false', runtime,
], upstream)
await materializeLinks(resolve(runtime, 'node_modules'))
await materializeWorkspaceRoots(runtime, upstream)
await repairDshNativePackages(runtime, upstream)
await verifyDshNativePackages(runtime)
await rm(resolve(runtime, 'src'), { recursive: true, force: true })
await copyTree(resolve(upstream, 'apps/cli'), resolve(runtime, 'node_modules/@deepseek-ai/dsh'))
await copyTree(resolve(repo, 'dsh-appserver'), resolve(runtime, 'node_modules/dsh-appserver'), true)
await copyTree(resolve(repo, 'dsh-flowix-memory'), resolve(runtime, 'node_modules/dsh-flowix-memory'), true)

await mkdir(resolve(profile, 'node_modules'), { recursive: true })
await copyTree(resolve(repo, 'dsh-appserver'), resolve(profile, 'node_modules/dsh-appserver'), true)
await copyTree(resolve(repo, 'dsh-flowix-memory'), resolve(profile, 'node_modules/dsh-flowix-memory'), true)
await cp(resolve(repo, 'scripts/dsh-dev-profile.patch.yml'), resolve(profile, 'cordis.patch.yml'))
await writeFile(resolve(profile, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-flowix', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-appserver', 'dsh-flowix-memory'] } },
}, null, 2)}\n`)

await mkdir(resolve(bundle, 'node'), { recursive: true })
await cp(process.execPath, resolve(bundle, 'node/node.exe'))
await installPrivatePnpm(bundle)
await writeFile(resolve(bundle, 'runtime-build.json'), `${JSON.stringify({
  target, nodeVersion: process.version, nodeAbi: process.versions.modules, pnpmVersion,
}, null, 2)}\n`)
console.log(`created Windows DSH production runtime bundle: ${bundle}`)

async function installPrivatePnpm(root) {
  const toolRoot = resolve(root, 'tools/pnpm')
  await mkdir(toolRoot, { recursive: true })
  await writeFile(resolve(toolRoot, 'package.json'), `${JSON.stringify({
    name: 'flowix-dsh-private-tools', private: true, dependencies: { pnpm: pnpmVersion },
  }, null, 2)}\n`)
  await run(process.execPath, [
    corepack, `pnpm@${pnpmVersion}`, '--dir', toolRoot, '--ignore-workspace', 'install', '--prod', '--ignore-scripts',
    '--config.manage-package-manager-versions=false', '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
  ], dirname(repo))
  await materializeLinks(resolve(toolRoot, 'node_modules'))
  if (!existsSync(resolve(toolRoot, 'node_modules/pnpm/bin/pnpm.mjs'))) {
    throw new Error('private pnpm entrypoint was not installed')
  }
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
  const manifestPath = resolve(workspaceRoot, 'python/sdk-runtime/package.json')
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
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

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    console.log(`> ${command} ${args.join(' ')}`)
    const child = spawn(command, args, { cwd, env: { ...process.env }, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
  })
}
