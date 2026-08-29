import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmEntrypoint = process.env.npm_execpath
const tauriEntrypoint = resolve(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')
const config = process.argv[2] ?? 'app/flowix-desktop/tauri.conf.dev.json'
const childEnv = { ...process.env }

// Build and use the managed DSH bundle in dev. The bundle contains the private
// Node and official CLI entrypoint, so the Rust client can launch the same
// `app-server --listen stdio://` surface used by the production runtime.

if (process.platform === 'win32') {
  // rustup installs Cargo here by default. GUI shells and automation often do
  // not inherit the updated user PATH until they are restarted.
  const cargoBin = join(homedir(), '.cargo', 'bin')
  const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path') ?? 'Path'
  childEnv[pathKey] = `${cargoBin}${delimiter}${childEnv[pathKey] ?? ''}`

  // The source checkout already contains the vendored Harness runtime. Point
  // the bundled JS host back to that source root; otherwise it resolves from
  // .build/flowix-dsh-host and incorrectly reports that the runtime is absent.
  childEnv.FLOWIX_DSH_ROOT ??= resolve(repoRoot, 'dsh-flowix-host')
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: childEnv,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function npmRun(script) {
  if (process.platform === 'win32' && npmEntrypoint) {
    // Node 24 rejects direct spawnSync of some .cmd wrappers with EINVAL.
    run(process.execPath, [npmEntrypoint, 'run', script])
  } else {
    run(npm, ['run', script])
  }
}

npmRun('cli:build:dev')

{
  const bundleRoot = resolve(
    repoRoot,
    `.build/dsh-runtime-bundle/node24-${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`,
  )
  const complete = [
    join(bundleRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    join(bundleRoot, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    join(bundleRoot, 'profile/flowix/package.json'),
    join(bundleRoot, 'profile/flowix/node_modules/dsh-appserver/package.json'),
    join(bundleRoot, 'profile/flowix/node_modules/dsh-flowix-memory/package.json'),
  ].every(existsSync)
  if (!complete) {
    const lock = resolve(repoRoot, '.build/dsh-runtime-bundle/.dev-build.lock')
    try {
      mkdirSync(lock)
    } catch (error) {
      throw new Error(`DSH dev bundle is being built by another process (${lock}): ${String(error)}`)
    }
    try {
      npmRun('dsh:build:prod')
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  }
}
if (process.platform === 'win32') {
  const devHost = resolve(repoRoot, '.build/flowix-dsh-host/dsh-host.cjs')
  if (!existsSync(devHost)) {
    throw new Error(`Windows development host was not built at ${devHost}`)
  }
}

run(process.execPath, [tauriEntrypoint, 'dev', '--config', config])
