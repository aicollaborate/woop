import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const configuredSource = process.env.FLOWIX_DSH_UPSTREAM_ROOT?.trim()
const source = configuredSource
  ? resolve(configuredSource)
  : resolve(repo, '.build/upstream/deepseek-harness')
const lock = JSON.parse(await readFile(resolve(repo, 'dsh/upstream.lock.json'), 'utf8'))

if (configuredSource) {
  if (process.env.FLOWIX_DSH_REQUIRE_PINNED === '1') {
    throw new Error('FLOWIX_DSH_UPSTREAM_ROOT is not allowed for a pinned DSH production build')
  }
  if (!existsSync(resolve(source, 'package.json'))) {
    throw new Error(`FLOWIX_DSH_UPSTREAM_ROOT does not contain a DSH checkout: ${source}`)
  }
  console.log(`using configured DSH upstream root ${source}`)
} else if (isCheckoutAtCommit()) {
  console.log(`using DSH upstream ${lock.commit}`)
} else {
  await rm(source, { recursive: true, force: true })
  await mkdir(resolve(repo, '.build/upstream'), { recursive: true })
  await run('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth=1', lock.repository, source], repo)
  await run('git', ['fetch', '--depth=1', 'origin', lock.commit], source)
  await run('git', ['checkout', '--detach', lock.commit], source)
  console.log(`prepared DSH upstream ${lock.commit}`)
}

function isCheckoutAtCommit() {
  if (!existsSync(resolve(source, '.git')) && !existsSync(resolve(source, 'HEAD'))) return false
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' })
  if (result.status !== 0 || result.stdout.toString().trim() !== lock.commit) return false
  const workingTree = spawnSync('git', ['diff', '--quiet'], { cwd: source })
  const index = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: source })
  return workingTree.status === 0 && index.status === 0
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
  })
}
