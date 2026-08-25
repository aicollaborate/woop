import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmEntrypoint = process.env.npm_execpath
const tauriEntrypoint = resolve(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')
const config = process.argv[2] ?? 'app/flowix-desktop/tauri.conf.dev.json'

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!process.env.FLOWIX_DSH_BUNDLE_ROOT) {
  if (process.platform === 'win32' && npmEntrypoint) {
    // Node 24 rejects direct spawnSync of some .cmd wrappers with EINVAL.
    // npm exposes its real JS entrypoint to lifecycle scripts, so execute that
    // with the current Node process and keep shell parsing out of the path.
    run(process.execPath, [npmEntrypoint, 'run', 'dsh:build:dev'])
  } else {
    run(npm, ['run', 'dsh:build:dev'])
  }
}
run(process.execPath, [tauriEntrypoint, 'dev', '--config', config])
