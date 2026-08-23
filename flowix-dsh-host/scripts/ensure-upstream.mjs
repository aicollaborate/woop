import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isTrustedCheckout, patchSetDigest } from './upstream-integrity.mjs'

const hostRoot = resolve(import.meta.dirname, '..')
const compatibilityPath = resolve(hostRoot, 'vendor/deepseek-harness')
const lock = JSON.parse(await readFile(resolve(hostRoot, 'upstream.lock.json'), 'utf8'))
const patchDigest = await patchSetDigest(hostRoot, lock)
if (!existsSync(resolve(compatibilityPath, 'package.json'))
  || !(await isTrustedCheckout(compatibilityPath, lock.commit, patchDigest))) {
  await import('./sync-upstream.mjs')
}
