import { existsSync } from 'node:fs'
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  isTrustedCheckout,
  patchSetDigest,
  treeDigest,
  UPSTREAM_PATCH_DIGEST,
  UPSTREAM_TREE_DIGEST,
} from './upstream-integrity.mjs'

const hostRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(hostRoot, '..')
const lockPath = resolve(hostRoot, 'upstream.lock.json')
const lock = JSON.parse(await readFile(lockPath, 'utf8'))
const repository = lock.repository
// This module is also imported by build scripts that pass their own flags
// (for example `--targets=...`). Those flags are not upstream commit ids and
// must not be mistaken for the optional sync argument.
const requestedArgument = process.argv[2]
const requested = requestedArgument === undefined || requestedArgument.startsWith('--')
  ? lock.commit
  : requestedArgument
const patchDigest = await patchSetDigest(hostRoot, lock)
if (requested === undefined || !/^[0-9a-f]{40}$/i.test(requested)) {
  throw new Error('usage: node scripts/sync-upstream.mjs [40-character-commit]')
}

const upstreamRoot = resolve(repoRoot, '.build/upstream')
const target = resolve(upstreamRoot, 'deepseek-harness')
const compatibilityPath = resolve(hostRoot, 'vendor/deepseek-harness')
// Keep the temporary checkout on the workspace volume. Windows cannot rename
// a directory atomically from the system temp drive (usually C:) into a
// workspace located on another drive (for example D:), and reports EXDEV.
await mkdir(upstreamRoot, { recursive: true })
const temporaryRoot = await mkdtemp(resolve(upstreamRoot, '.flowix-dsh-upstream-'))
const checkout = resolve(temporaryRoot, 'checkout')
const backup = resolve(upstreamRoot, `.deepseek-harness.backup-${process.pid}`)

async function main() {
 try {
  // A package.json alone is not evidence that this directory came from the
  // locked upstream checkout. The marker is paired with a content digest;
  // neither one alone is allowed to bless modified generated contents.
  if (existsSync(resolve(target, 'package.json'))
    && await isTrustedCheckout(target, requested, patchDigest)) {
    await ensureCompatibilityPath()
    process.stdout.write(`using existing upstream checkout at ${target}\n`)
    return
  }
  await mkdir(upstreamRoot, { recursive: true })
  run('git', ['init', '--quiet', checkout], hostRoot)
  run('git', ['-C', checkout, 'remote', 'add', 'origin', repository], hostRoot)
  run('git', ['-C', checkout, 'fetch', '--depth=1', 'origin', requested], hostRoot)
  run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], hostRoot)
  const resolved = capture('git', ['-C', checkout, 'rev-parse', 'HEAD'], hostRoot)
  if (resolved.toLowerCase() !== requested.toLowerCase()) {
    throw new Error(`upstream resolved to ${resolved}, expected ${requested}`)
  }
  for (const patch of lock.patches) {
    applyPatch(resolve(hostRoot, patch))
  }
  const digest = await treeDigest(checkout)
  await rm(resolve(checkout, '.git'), { recursive: true, force: true })

  await rm(backup, { recursive: true, force: true })
  if (existsSync(target)) await rename(target, backup)
  try {
    await rename(checkout, target)
    await writeFile(resolve(target, '.flowix-upstream-commit'), `${requested}\n`, 'utf8')
    await writeFile(resolve(target, UPSTREAM_TREE_DIGEST), `${digest}\n`, 'utf8')
    await writeFile(resolve(target, UPSTREAM_PATCH_DIGEST), `${patchDigest}\n`, 'utf8')
  } catch (error) {
    if (existsSync(backup)) await rename(backup, target)
    throw error
  }
  await rm(backup, { recursive: true, force: true })
  await ensureCompatibilityPath()
  process.stdout.write(`synced ${repository} at ${resolved}\n`)
  process.stdout.write(`upstream checkout is generated at ${target}; install its pnpm closure before building\n`)
 } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()

async function ensureCompatibilityPath() {
  await mkdir(resolve(hostRoot, 'vendor'), { recursive: true })
  try {
    const existing = await lstat(compatibilityPath)
    if (existing.isSymbolicLink()) {
      await rm(compatibilityPath, { recursive: true, force: true })
    } else {
      throw new Error(`refusing to replace a real checkout at ${compatibilityPath}; move it to ${target} first`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await symlink(target, compatibilityPath, process.platform === 'win32' ? 'junction' : 'dir')
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${basename(command)} exited with ${String(result.status)}`)
}

function applyPatch(patchPath) {
  const normal = spawnSync('git', ['-C', checkout, 'apply', patchPath], {
    cwd: hostRoot,
    stdio: 'ignore',
  })
  if (normal.status === 0) return

  // Older locked patches may carry stale hunk line counts after a preceding
  // patch. Recount only as a compatibility fallback; valid generated patches
  // should be checked and applied with their original hunk metadata first.
  const recounted = spawnSync('git', ['-C', checkout, 'apply', '--recount', patchPath], {
    cwd: hostRoot,
    stdio: 'inherit',
  })
  if (recounted.status !== 0) {
    throw new Error(`git apply failed for ${patchPath}`)
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${basename(command)} exited with ${String(result.status)}`)
  return result.stdout.trim()
}
