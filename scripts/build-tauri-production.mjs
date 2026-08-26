import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const npmEntrypoint = process.env.npm_execpath
const tauriEntrypoint = path.resolve(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')
const cargoTargetDir = path.resolve(process.env.CARGO_TARGET_DIR || path.resolve(repoRoot, '.build/cargo-target'))
process.env.CARGO_TARGET_DIR = cargoTargetDir
if (process.platform === 'win32') {
  const cargoBin = path.join(homedir(), '.cargo', 'bin')
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path'
  process.env[pathKey] = `${cargoBin}${delimiter}${process.env[pathKey] ?? ''}`
}
const platformArgIndex = process.argv.indexOf('--platform')
const targetPlatform = platformArgIndex >= 0
  ? process.argv[platformArgIndex + 1]
  : process.platform

if (!['win32', 'darwin', 'linux'].includes(targetPlatform)) {
  throw new Error(`Unsupported --platform value: ${targetPlatform ?? '<missing>'}`)
}
if (!npmEntrypoint) {
  throw new Error('Production build must be started through npm run tauri:build:prod')
}

const cargoManifest = readFileSync(path.resolve(repoRoot, 'app/Cargo.toml'), 'utf8')
const cargoVersion = /^version\s*=\s*"([^"]+)"/mu.exec(cargoManifest)?.[1]
const tauriConfig = JSON.parse(readFileSync(
  path.resolve(repoRoot, 'app/flowix-desktop/tauri.conf.json'), 'utf8'))
const packageVersion = JSON.parse(readFileSync(path.resolve(repoRoot, 'package.json'), 'utf8')).version
if (!cargoVersion || cargoVersion !== tauriConfig.version || cargoVersion !== packageVersion) {
  throw new Error(
    `Flowix version mismatch: Cargo=${cargoVersion ?? '<missing>'}, ` +
    `Tauri=${tauriConfig.version ?? '<missing>'}, package=${packageVersion ?? '<missing>'}`,
  )
}

const MACOS_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin']

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    shell: false,
    env: process.env,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout?.trim()
}

function npmRun(script) {
  run(process.execPath, [npmEntrypoint, 'run', script])
}

if (!process.env.FLOWIX_DSH_UPDATE_PUBLIC_KEY?.trim()) {
  process.env.FLOWIX_DSH_UPDATE_PUBLIC_KEY = run(
    process.execPath,
    ['scripts/derive-dsh-public-key.mjs'],
    { capture: true },
  )
}

if (targetPlatform === 'darwin') npmRun('cli:build:prod:macos')
else npmRun('cli:build:prod')

const configPath = run(
  process.execPath,
  ['scripts/prepare-tauri-production-config.mjs', '--platform', targetPlatform],
  { capture: true },
)
if (!configPath) throw new Error('Production config generator did not return a config path.')

const tauriTargets = targetPlatform === 'darwin' ? MACOS_TARGETS : [null]
const buildStartedAt = Date.now()
for (const target of tauriTargets) {
  const buildArgs = ['build', '--config', configPath]
  if (target) buildArgs.push('--target', target)
  run(process.execPath, [tauriEntrypoint, ...buildArgs])
}

const freshArtifacts = collectFiles(cargoTargetDir)
  .filter(file => statSync(file).mtimeMs >= buildStartedAt - 2_000)
if (targetPlatform === 'win32') {
  const updater = requireArtifact(
    freshArtifacts,
    file => file.endsWith('-setup.exe') && file.includes(`${path.sep}bundle${path.sep}nsis${path.sep}`),
    'NSIS installer/updater',
  )
  requireArtifact(freshArtifacts, file => file === `${updater}.sig`, 'NSIS updater signature')
} else if (targetPlatform === 'darwin') {
  for (const target of MACOS_TARGETS) {
    const targetFiles = freshArtifacts.filter(file => file.includes(`${path.sep}${target}${path.sep}`))
    requireArtifact(targetFiles, file => file.endsWith('.dmg'), `${target} DMG`)
    const updater = requireArtifact(targetFiles, file => file.endsWith('.app.tar.gz'), `${target} updater archive`)
    requireArtifact(targetFiles, file => file === `${updater}.sig`, `${target} updater signature`)
  }
}

function collectFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(candidate))
    else if (entry.isFile()) files.push(candidate)
  }
  return files
}

function requireArtifact(files, predicate, label) {
  const artifact = files.find(predicate)
  if (!artifact) throw new Error(`Tauri reported success but did not create a fresh ${label}`)
  process.stdout.write(`verified ${label}: ${artifact}\n`)
  return artifact
}
