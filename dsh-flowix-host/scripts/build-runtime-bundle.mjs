import { spawn } from 'node:child_process'
import { chmod, cp, lstat, mkdir, readFile, readlink, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

await import('./ensure-upstream.mjs')

const hostRoot = resolve(import.meta.dirname, '..')
const repo = resolve(hostRoot, '..')
const vendor = resolve(hostRoot, 'vendor/deepseek-harness')
const target = process.argv.find(value => value.startsWith('--target='))?.slice(9) ?? hostTarget()
if (!/^node24-(windows-x64|macos-(?:x64|arm64)|linux-(?:x64|arm64))$/.test(target)) {
  throw new Error(`unsupported runtime bundle target: ${target}`)
}
const expectedTarget = hostTarget()
if (target !== expectedTarget) {
  throw new Error(
    `runtime bundle target ${target} does not match the active Node runtime ${expectedTarget}; ` +
    `run this build under a matching Node binary (on Apple Silicon use a Rosetta x64 Node for node24-macos-x64)`,
  )
}
const bundle = resolve(repo, '.build/dsh-runtime-bundle', target)
const runtime = join(bundle, 'runtime')
const privatePnpmVersion = '11.7.0'

await run(corepack(), ['pnpm@11.7.0', 'install', '--frozen-lockfile', '--prod=false'], vendor)
const builtMarkers = [
  resolve(vendor, 'apps/cli/lib/bin.js'),
  resolve(vendor, 'packages/examples/jsonrpc-demo/lib/packaged-bin.js'),
  resolve(vendor, 'packages/llm/llm-pi-ai/lib/types/catalog.js'),
]
if (!builtMarkers.every(existsSync) || process.env.FLOWIX_DSH_REBUILD_LIBS === '1') {
  await run(corepack(), ['pnpm@11.7.0', 'run', 'build:lib:host'], vendor)
}
if (process.env.FLOWIX_DSH_SKIP_HOST_BUILD !== '1') {
  await run(process.execPath, [resolve(hostRoot, 'scripts/build-host.mjs')], hostRoot, {
    ...process.env,
    FLOWIX_DSH_SKIP_RUNTIME: '1',
  })
}
await rm(bundle, { recursive: true, force: true })
await mkdir(bundle, { recursive: true })
await run(corepack(), [
  'pnpm@11.7.0', '--filter', 'dsh-jsonrpc-agent-pkg', 'deploy', '--legacy', '--prod',
  '--config.node-linker=hoisted', '--config.auto-install-peers=false',
  '--config.link-workspace-packages=true', process.platform === 'win32' ? `"${runtime}"` : runtime,
], vendor)
await materializeLinks(join(runtime, 'node_modules'))
await materializeWorkspaceRoots(runtime, vendor)
// `pnpm deploy` preserves package `files` content, including the upstream
// runtime source snapshot under runtime/src. It contains a second runtime
// binary and a second node_modules tree and is not used by the managed host.
// Remove it from the distributable bundle to avoid shipping build residue.
await rm(join(runtime, 'src'), { recursive: true, force: true })
// The headless DSH host does not ship the browser UI. The upstream CLI keeps
// UI packages in its workspace dependency graph, so prune those packages
// after deploy; the closure verifier explicitly treats them as optional for
// this headless distribution.
await removeClientUiPackages(runtime)

await copyTree(resolve(repo, 'dsh-flowix-memory'), join(runtime, 'node_modules/dsh-flowix-memory'))
// pnpm's legacy deploy can omit direct workspace roots even though their
// transitive production closure is present. Materialize the two executable
// roots explicitly so the managed bundle never depends on workspace links.
await copyTree(resolve(vendor, 'apps/cli'), join(runtime, 'node_modules/@deepseek-ai/dsh'))
await copyTree(resolve(vendor, 'packages/sdk/server'), join(runtime, 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server'))
await copyTree(resolve(vendor, 'packages/sdk/protocol'), join(runtime, 'node_modules/@deepseek-ai/dsh-sdk-protocol'))
await copyTree(resolve(vendor, 'packages/shell/shell'), join(runtime, 'node_modules/@deepseek-ai/dsh-shell'))
await copyTree(resolve(vendor, 'packages/subagent/subagent-in-process-driver'), join(runtime, 'node_modules/@deepseek-ai/dsh-subagent-in-process-driver'))
await copyTree(resolve(hostRoot, 'profile/flowix'), join(bundle, 'profile/flowix'))
await mkdir(join(bundle, 'host'), { recursive: true })
await cp(resolve(repo, '.build/flowix-dsh-host/dsh-host.cjs'), join(bundle, 'host/dsh-host.cjs'))
await mkdir(join(bundle, 'node'), { recursive: true })
const nodeExecutable = join(bundle, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
await cp(process.execPath, nodeExecutable)
if (process.platform === 'darwin') await optimizeMacosBundle(bundle, target, nodeExecutable)
await installPrivatePnpm(bundle)
await writePrivateShims(bundle)
await writeFile(join(bundle, 'runtime-build.json'), `${JSON.stringify({
  target,
  nodeVersion: process.version,
  nodeAbi: process.versions.modules,
  pnpmVersion: privatePnpmVersion,
}, null, 2)}\n`)
await run(process.execPath, [resolve(hostRoot, 'scripts/verify-runtime-closure.mjs'), bundle], hostRoot)

process.stdout.write(`${bundle}\n`)

function hostTarget() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  return `node24-${platform}-${process.arch}`
}
function corepack() { return process.platform === 'win32' ? 'corepack.cmd' : 'corepack' }
async function optimizeMacosBundle(bundleRoot, runtimeTarget, nodeExecutable) {
  const nodeArch = runtimeTarget.endsWith('-arm64') ? 'arm64' : 'x86_64'
  const temporaryNode = `${nodeExecutable}.thin`
  await run('lipo', ['-thin', nodeArch, nodeExecutable, '-output', temporaryNode], bundleRoot)
  await rename(temporaryNode, nodeExecutable)

  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || '-'
  const entitlements = resolve(hostRoot, 'node-entitlements.plist')
  const signArgs = ['--force', '--options', 'runtime', '--entitlements', entitlements]
  if (identity !== '-') signArgs.push('--timestamp')
  signArgs.push('--sign', identity, nodeExecutable)
  await run('codesign', signArgs, bundleRoot)

  const nodePty = join(bundleRoot, 'runtime/node_modules/node-pty')
  const keepPrebuild = runtimeTarget.endsWith('-arm64') ? 'darwin-arm64' : 'darwin-x64'
  const prebuilds = join(nodePty, 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== keepPrebuild) {
        await rm(join(prebuilds, entry.name), { recursive: true, force: true })
      }
    }
  }
  await rm(join(nodePty, 'third_party'), { recursive: true, force: true })
}
async function copyTree(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true, force: true })
}
async function materializeLinks(directory) {
  if (!existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      const source = resolve(dirname(path), await readlink(path))
      await rm(path, { recursive: true, force: true })
      await cp(source, path, { recursive: true, dereference: true })
    } else if (info.isDirectory()) {
      if (entry.name === '.bin') await rm(path, { recursive: true, force: true })
      else await materializeLinks(path)
    }
  }
}
async function materializeWorkspaceRoots(runtimeRoot, workspaceRoot) {
  const deployManifest = JSON.parse(await readFile(resolve(workspaceRoot, 'python/sdk-runtime/package.json'), 'utf8'))
  const required = Object.keys(deployManifest.dependencies ?? {})
  const packages = new Map()
  for (const searchRoot of ['apps', 'packages', 'vendor']) {
    await indexWorkspacePackages(resolve(workspaceRoot, searchRoot), packages)
  }
  for (const name of required) {
    const destination = resolve(runtimeRoot, 'node_modules', ...name.split('/'))
    if (existsSync(resolve(destination, 'package.json'))) continue
    const source = packages.get(name)
    if (source === undefined) throw new Error(`managed runtime dependency ${name} was omitted by pnpm deploy and is not a workspace package`)
    await copyTree(source, destination)
  }
}
async function removeClientUiPackages(scope) {
  if (!existsSync(scope)) return
  for (const entry of await readdir(scope, { withFileTypes: true })) {
    const path = join(scope, entry.name)
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('dsh-client-ui-')) await rm(path, { recursive: true, force: true })
    else await removeClientUiPackages(path)
  }
}
async function indexWorkspacePackages(directory, packages) {
  if (!existsSync(directory)) return
  const manifest = resolve(directory, 'package.json')
  if (existsSync(manifest)) {
    const value = JSON.parse(await readFile(manifest, 'utf8'))
    if (typeof value.name === 'string') packages.set(value.name, directory)
    return
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      await indexWorkspacePackages(resolve(directory, entry.name), packages)
    }
  }
}
async function installPrivatePnpm(bundleRoot) {
  const toolRoot = join(bundleRoot, 'tools/pnpm')
  await copyTree(resolve(hostRoot, 'private-pnpm'), toolRoot)
  await run(corepack(), [
    `pnpm@${privatePnpmVersion}`, '--ignore-workspace', 'install', '--prod', '--ignore-scripts',
    '--frozen-lockfile', '--config.manage-package-manager-versions=false',
    '--config.node-linker=hoisted', '--config.auto-install-peers=false',
  ], toolRoot)
  await materializeLinks(join(toolRoot, 'node_modules'))
}
async function writePrivateShims(bundleRoot) {
  const bin = join(bundleRoot, 'bin')
  await mkdir(bin, { recursive: true })
  const windows = {
    'pnpm.cmd': '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\tools\\pnpm\\node_modules\\pnpm\\bin\\pnpm.mjs" %*\r\n',
    'dsh.cmd': '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
  }
  const unix = {
    pnpm: '#!/bin/sh\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$ROOT/node/node" "$ROOT/tools/pnpm/node_modules/pnpm/bin/pnpm.mjs" "$@"\n',
    dsh: '#!/bin/sh\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$ROOT/node/node" "$ROOT/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n',
  }
  const shims = process.platform === 'win32' ? windows : unix
  for (const [name, contents] of Object.entries(shims)) {
    const path = join(bin, name)
    await writeFile(path, contents)
    if (process.platform !== 'win32') await chmod(path, 0o755)
  }
}
async function run(command, args, cwd, env = process.env) {
  process.stdout.write(`> ${basename(command)} ${args.join(' ')}\n`)
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.cmd') })
  const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', ok) })
  if (code !== 0) throw new Error(`${command} exited with ${code}`)
}
