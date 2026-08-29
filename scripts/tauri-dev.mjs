import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmEntrypoint = process.env.npm_execpath
const tauriEntrypoint = resolve(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')
const config = process.argv[2] ?? 'app/flowix-desktop/tauri.conf.dev.json'
const childEnv = { ...process.env }

// Keep the legacy Flowix host as the development default. The official DSH
// `--app-server` surface does not implement Flowix's model/config, credential
// and bridge methods (for example `model/config/read`), so enabling it here
// makes reconnect fail before a conversation can start. A compatible App
// Server can still be selected explicitly through these environment variables.

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

if (!process.env.FLOWIX_DSH_BUNDLE_ROOT) {
  npmRun('dsh:build:dev')
}

if (process.platform === 'win32' && !childEnv.FLOWIX_DSH_BUNDLE_ROOT) {
  const devHost = resolve(repoRoot, '.build/flowix-dsh-host/dsh-host.cjs')
  if (!existsSync(devHost)) {
    throw new Error(`Windows development host was not built at ${devHost}`)
  }
}

run(process.execPath, [tauriEntrypoint, 'dev', '--config', config])
