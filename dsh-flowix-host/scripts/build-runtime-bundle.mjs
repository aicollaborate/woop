import { spawn } from 'node:child_process'
import { chmod, cp, lstat, mkdir, readFile, readlink, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`DSH production bundles require Node 24; current runtime is ${process.version}`)
}

// pnpm may need to remove a stale modules tree during a bundle rebuild. The
// build is non-interactive in both local automation and CI, so opt into its
// deterministic no-prompt behavior.
process.env.CI = 'true'
process.env.NODE_ENV = 'development'
process.env.NPM_CONFIG_PRODUCTION = 'false'
process.env.npm_config_production = 'false'

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
  resolve(vendor, 'packages/llm/llm-pi-ai/lib/types/catalog.js'),
]
if (!builtMarkers.every(existsSync) || process.env.FLOWIX_DSH_REBUILD_LIBS === '1') {
  await run(corepack(), ['pnpm@11.7.0', 'run', 'build:lib:host'], vendor)
}
await rm(bundle, { recursive: true, force: true })
await mkdir(bundle, { recursive: true })
await run(corepack(), [
  // Deploy is used only as a dependency-closure materializer. The SDK server
  // package is pruned below and the executable root is replaced by the real
  // DSH CLI package, so it can never become Flowix's runtime entry point.
  'pnpm@11.7.0', '--filter', 'dsh-jsonrpc-agent-pkg', 'deploy', '--legacy', '--prod',
  '--config.node-linker=hoisted', '--config.auto-install-peers=false',
  '--config.link-workspace-packages=true', runtime,
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
// Keep the upstream SDK JSON-RPC package in the runtime closure for DSH's
// internal carrier/runtime compatibility. The Flowix profile disables its
// plugin entry, so dsh-appserver remains the only active stdin/stdout owner.
await rm(join(runtime, 'node_modules/@flowix/dsh-flowix-bridge'), { recursive: true, force: true })

await copyTree(resolve(repo, 'dsh-flowix-memory'), join(runtime, 'node_modules/dsh-flowix-memory'))
await copyTree(resolve(repo, 'dsh-appserver'), join(runtime, 'node_modules/dsh-appserver'), { skipNodeModules: true })
// pnpm's legacy deploy can omit direct workspace roots even though their
// transitive production closure is present. Materialize the two executable
// roots explicitly so the managed bundle never depends on workspace links.
await copyTree(resolve(vendor, 'apps/cli'), join(runtime, 'node_modules/@deepseek-ai/dsh'))
await copyTree(resolve(vendor, 'packages/sdk/protocol'), join(runtime, 'node_modules/@deepseek-ai/dsh-sdk-protocol'))
await copyTree(resolve(vendor, 'packages/shell/shell'), join(runtime, 'node_modules/@deepseek-ai/dsh-shell'))
await copyTree(resolve(vendor, 'packages/subagent/subagent-in-process-driver'), join(runtime, 'node_modules/@deepseek-ai/dsh-subagent-in-process-driver'))
// The profile source may contain development-time workspace links under
// node_modules. Do not follow those links into the distributable bundle;
// dsh-appserver and memory are materialized into the runtime closure below.
await copyTree(resolve(hostRoot, 'profile/flowix'), join(bundle, 'profile/flowix'), { skipNodeModules: true })
// The profile loader resolves its bundles relative to profile/flowix, so the
// two Flowix-owned packages must also be materialized there. Copying only the
// runtime closure is insufficient for `dsh --profile flowix`.
await copyTree(resolve(repo, 'dsh-appserver'), join(bundle, 'profile/flowix/node_modules/dsh-appserver'), { skipNodeModules: true })
await copyTree(resolve(repo, 'dsh-flowix-memory'), join(bundle, 'profile/flowix/node_modules/dsh-flowix-memory'), { skipNodeModules: true })
for (const packageName of ['dsh-appserver', 'dsh-flowix-memory']) {
  const packageJson = join(bundle, 'profile/flowix/node_modules', packageName, 'package.json')
  if (!existsSync(packageJson)) {
    throw new Error(`Flowix profile is incomplete: ${packageName} is missing from ${dirname(packageJson)}`)
  }
}
await mkdir(join(bundle, 'node'), { recursive: true })
const nodeExecutable = join(bundle, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
await cp(process.execPath, nodeExecutable)
if (process.platform === 'darwin') await optimizeMacosBundle(bundle, target, nodeExecutable)
await installPrivatePnpm(bundle)
await writePrivateShims(bundle)
if (process.platform === 'win32') await optimizeWindowsBundle(bundle, target)
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
function corepack() {
  if (process.platform !== 'win32') return 'corepack'
  // Invoke Corepack's JS entry directly. Spawning corepack.cmd through cmd.exe
  // re-parses whitespace-bearing deploy targets and corrupts Windows paths.
  return resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js')
}
async function optimizeMacosBundle(bundleRoot, runtimeTarget, nodeExecutable) {
  const nodeArch = runtimeTarget.endsWith('-arm64') ? 'arm64' : 'x86_64'
  const temporaryNode = `${nodeExecutable}.thin`
  await run('lipo', ['-thin', nodeArch, nodeExecutable, '-output', temporaryNode], bundleRoot)
  await rename(temporaryNode, nodeExecutable)

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
async function optimizeWindowsBundle(bundleRoot, runtimeTarget) {
  // A target-specific archive cannot load node-pty binaries built for the
  // other Windows architecture. Keep the x64 runtime closure unchanged and
  // remove only the explicitly non-target prebuild.
  const nodePty = join(bundleRoot, 'runtime/node_modules/node-pty')
  const nonTargetPrebuild = runtimeTarget.endsWith('-x64') ? 'win32-arm64' : 'win32-x64'
  await rm(join(nodePty, 'prebuilds', nonTargetPrebuild), { recursive: true, force: true })

  // PDB files contain native debug symbols and are never loaded at runtime.
  // Production symbols can be retained separately without shipping them to
  // every user.
  await removeFilesByExtension(bundleRoot, '.pdb')
}
async function removeFilesByExtension(directory, extension) {
  if (!existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await removeFilesByExtension(path, extension)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      await rm(path, { force: true })
    }
  }
}
async function copyTree(source, destination, options = {}) {
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (options.skipNodeModules && entry.name === 'node_modules') continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isSymbolicLink()) {
      const target = resolve(dirname(from), await readlink(from))
      if (!existsSync(target)) continue
      await copyTree(target, to, options)
    } else if (entry.isDirectory()) {
      await copyTree(from, to, options)
    } else if (entry.isFile()) {
      await mkdir(dirname(to), { recursive: true })
      await cp(from, to, { force: true })
    }
  }
}
async function materializeLinks(directory) {
  if (!existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      const source = resolve(dirname(path), await readlink(path))
      // pnpm deploy can leave workspace-only links pointing at its temporary
      // hoisted tree. They are not part of the distributable closure; omit
      // only broken links and keep materializing valid package links.
      if (!existsSync(source)) {
        await rm(path, { force: true })
        continue
      }
      await rm(path, { recursive: true, force: true })
      await copyTree(source, path)
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
async function run(command, args, cwd, env = {
  ...process.env,
  CI: 'true',
  NODE_ENV: 'development',
  NPM_CONFIG_PRODUCTION: 'false',
  npm_config_production: 'false',
}) {
  process.stdout.write(`> ${basename(command)} ${args.join(' ')}\n`)
  let executable = command
  let executableArgs = args
  let shell = false
  if (process.platform === 'win32' && command.endsWith('corepack.js')) {
    executable = process.execPath
    executableArgs = [command, ...args]
  }
  if (process.platform === 'win32' && command.endsWith('.cmd')) {
    // Node cannot reliably spawn .cmd files with shell=true when arguments
    // contain spaces. Route through cmd.exe and quote each argument once.
    const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`
    executable = process.env.ComSpec || 'cmd.exe'
    const commandPart = quote(command)
    const commandLine = `${commandPart} ${args.map((value) => /\s/.test(String(value)) ? quote(value) : String(value)).join(' ')}`
    executableArgs = ['/d', '/s', '/c', `"${commandLine}"`]
  }
  const child = spawn(executable, executableArgs, { cwd, env, stdio: 'inherit', shell })
  const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', ok) })
  if (code !== 0) throw new Error(`${command} exited with ${code}`)
}
