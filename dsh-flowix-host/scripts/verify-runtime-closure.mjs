import { lstat, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const bundle = resolve(process.argv[2] ?? '')
if (!process.argv[2] || !existsSync(bundle)) throw new Error('usage: node verify-runtime-closure.mjs <bundle>')

const runtimeModules = join(bundle, 'runtime/node_modules')
const roots = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-sdk-protocol',
  '@deepseek-ai/dsh-shell',
  '@deepseek-ai/dsh-subagent-in-process-driver',
  'dsh-flowix-memory',
]
const visited = new Set()
const failures = []

await rejectLinks(bundle)
await rejectDevelopmentPaths(bundle)
for (const name of roots) await visitPackage(resolvePackage(runtimeModules, name), name)

const pnpmManifest = join(bundle, 'tools/pnpm/node_modules/pnpm/package.json')
if (!existsSync(pnpmManifest)) failures.push('private pnpm package is missing')
else await visitPackage(dirname(pnpmManifest), 'private pnpm')
for (const path of [
  join(bundle, process.platform === 'win32' ? 'node/node.exe' : 'node/node'),
  join(bundle, 'host/dsh-host.cjs'),
  join(bundle, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  join(bundle, 'tools/pnpm/node_modules/pnpm/bin/pnpm.mjs'),
  join(bundle, process.platform === 'win32' ? 'bin/pnpm.cmd' : 'bin/pnpm'),
  join(bundle, process.platform === 'win32' ? 'bin/dsh.cmd' : 'bin/dsh'),
  join(bundle, 'runtime-build.json'),
]) {
  if (!existsSync(path)) failures.push(`required private runtime file is missing: ${path}`)
}
if (failures.length) throw new Error(`managed runtime closure is incomplete:\n- ${failures.join('\n- ')}`)
process.stdout.write(`verified managed runtime closure (${visited.size} packages, no links)\n`)

async function visitPackage(directory, requestedBy) {
  const manifestPath = directory && join(directory, 'package.json')
  if (!directory || !existsSync(manifestPath)) {
    failures.push(`${requestedBy} cannot resolve to a physical package`)
    return
  }
  const real = resolve(directory)
  if (visited.has(real)) return
  visited.add(real)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await visitPackage(resolvePackage(dirname(directory), dependency), `${manifest.name ?? directory} -> ${dependency}`)
  }
  const optionalPeers = manifest.peerDependenciesMeta ?? {}
  for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
    if (optionalPeers[dependency]?.optional || !dependency.startsWith('@deepseek-ai/')) continue
    await visitPackage(resolvePackage(dirname(directory), dependency), `${manifest.name ?? directory} peer -> ${dependency}`)
  }
}

function resolvePackage(start, name) {
  let current = start
  const parts = name.split('/')
  while (current.startsWith(bundle + sep) || current === bundle) {
    const candidate = join(current, 'node_modules', ...parts)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const direct = join(current, ...parts)
    if (existsSync(join(direct, 'package.json'))) return direct
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

async function rejectLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) failures.push(`symbolic link is not allowed: ${path}`)
    else if (stat.isDirectory()) await rejectLinks(path)
  }
}

async function rejectDevelopmentPaths(directory) {
  const inspectNames = new Set(['package.json', 'runtime-build.json', 'pnpm-lock.yaml', 'pnpm', 'dsh', 'pnpm.cmd', 'dsh.cmd'])
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await rejectDevelopmentPaths(path)
    else if (entry.isFile() && inspectNames.has(entry.name)) {
      const contents = await readFile(path, 'utf8')
      const suspicious = contents.match(/(?:[A-Za-z]:\\(?:Users|02 vibeworking)\\[^\s"']+|\/(?:Users|home)\/[^\s"']+)/u)
      if (suspicious) failures.push(`development-machine absolute path is not allowed in ${path}: ${suspicious[0]}`)
    }
  }
}
