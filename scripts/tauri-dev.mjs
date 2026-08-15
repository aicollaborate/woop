import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tauri = resolve(
  repoRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
)
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

run(npm, ['run', 'dsh:build:dev'])
run(tauri, ['dev', '--config', config])
