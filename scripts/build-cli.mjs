import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const app = resolve(repo, 'app')
const binaries = resolve(app, 'flowix-desktop/binaries')
const debug = process.argv.includes('--debug')
const macos = process.argv.includes('--macos')
const targetArg = process.argv.find(value => value.startsWith('--target='))?.slice(9)
if (debug && (macos || targetArg)) throw new Error('--debug cannot be combined with a target build')
const cargoTarget = resolve(process.env.CARGO_TARGET_DIR || resolve(
  repo, debug ? '.build/cargo-target-cli-dev' : '.build/cargo-target'))

const childEnv = { ...process.env, CARGO_TARGET_DIR: cargoTarget }
if (process.platform === 'win32') {
  const cargoBin = join(homedir(), '.cargo', 'bin')
  const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path') ?? 'Path'
  childEnv[pathKey] = `${cargoBin}${delimiter}${childEnv[pathKey] ?? ''}`
}

function executable(name) {
  if (process.platform !== 'win32') return name
  const candidate = join(homedir(), '.cargo', 'bin', `${name}.exe`)
  return existsSync(candidate) ? candidate : name
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env: childEnv,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout?.trim() ?? ''
}

const supported = new Set([
  'x86_64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
])
const host = /^host:\s*(.+)$/mu.exec(run(executable('rustc'), ['-vV'], true))?.[1]
if (!host) throw new Error('rustc did not report a host target')
const targets = macos
  ? ['aarch64-apple-darwin', 'x86_64-apple-darwin']
  : targetArg ? [targetArg] : [host]
for (const target of targets) {
  if (!supported.has(target)) throw new Error(`unsupported CLI target: ${target}`)
}

mkdirSync(binaries, { recursive: true })
for (const target of targets) {
  const explicitTarget = macos || targetArg !== undefined
  const args = ['build', '--manifest-path', resolve(app, 'Cargo.toml'), '--bin', 'flowix-cli']
  if (explicitTarget) args.push('--target', target)
  if (!debug) args.push('--release')
  run(executable('cargo'), args)

  const profile = debug ? 'debug' : 'release'
  const extension = target.includes('windows') ? '.exe' : ''
  const source = explicitTarget
    ? resolve(cargoTarget, target, profile, `flowix-cli${extension}`)
    : resolve(cargoTarget, profile, `flowix-cli${extension}`)
  if (!existsSync(source)) throw new Error(`CLI build output is missing: ${source}`)
  const staged = resolve(binaries, `flowix-cli-${target}${extension}`)
  rmSync(staged, { force: true })
  copyFileSync(source, staged)
  if (!target.includes('windows')) chmodSync(staged, 0o755)
  process.stdout.write(`staged ${staged}\n`)

  if (!explicitTarget) {
    const development = resolve(binaries, `flowix-cli${extension}`)
    rmSync(development, { force: true })
    copyFileSync(staged, development)
    if (!target.includes('windows')) chmodSync(development, 0o755)
    process.stdout.write(`staged ${development}\n`)
  }

}
