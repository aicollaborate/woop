import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repository = 'https://github.com/deepseek-ai/deepseek-harness.git'
const requested = process.argv[2]
if (requested === undefined || !/^[0-9a-f]{40}$/i.test(requested)) {
  throw new Error('usage: node scripts/sync-upstream.mjs <40-character-commit>')
}

const hostRoot = resolve(import.meta.dirname, '..')
const target = resolve(hostRoot, 'vendor/deepseek-harness')
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'flowix-dsh-upstream-'))
const checkout = resolve(temporaryRoot, 'checkout')
const backup = resolve(hostRoot, 'vendor', `.deepseek-harness.backup-${process.pid}`)

try {
  run('git', ['init', '--quiet', checkout], hostRoot)
  run('git', ['-C', checkout, 'remote', 'add', 'origin', repository], hostRoot)
  run('git', ['-C', checkout, 'fetch', '--depth=1', 'origin', requested], hostRoot)
  run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], hostRoot)
  const resolved = capture('git', ['-C', checkout, 'rev-parse', 'HEAD'], hostRoot)
  if (resolved.toLowerCase() !== requested.toLowerCase()) {
    throw new Error(`upstream resolved to ${resolved}, expected ${requested}`)
  }
  run('git', ['-C', checkout, 'apply', resolve(hostRoot, 'patches/runtime-bash-sandbox.patch')], hostRoot)
  run('git', ['-C', checkout, 'apply', resolve(hostRoot, 'patches/production-deploy-postinstall.patch')], hostRoot)
  run('git', ['-C', checkout, 'apply', resolve(hostRoot, 'patches/downstream-single-exe-options.patch')], hostRoot)
  run('git', ['-C', checkout, 'apply', resolve(hostRoot, 'patches/agent-presets-sdk-server.patch')], hostRoot)
  run('git', ['-C', checkout, 'apply', resolve(hostRoot, 'patches/strip-dev-only-artifacts.patch')], hostRoot)
  run('git', ['-C', checkout, 'apply', resolve(hostRoot, 'patches/sdk-runtime-mcp-client.patch')], hostRoot)
  await rm(resolve(checkout, '.git'), { recursive: true, force: true })

  await rm(backup, { recursive: true, force: true })
  await rename(target, backup)
  try {
    await rename(checkout, target)
  } catch (error) {
    await rename(backup, target)
    throw error
  }
  await rm(backup, { recursive: true, force: true })
  process.stdout.write(`synced ${repository} at ${resolved}\n`)
  process.stdout.write('update UPSTREAM.md, reinstall the vendor closure, and run the full DSH checks\n')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${basename(command)} exited with ${String(result.status)}`)
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${basename(command)} exited with ${String(result.status)}`)
  return result.stdout.trim()
}
