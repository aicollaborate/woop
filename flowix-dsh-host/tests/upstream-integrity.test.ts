import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isTrustedCheckout,
  treeDigest,
  UPSTREAM_PATCH_DIGEST,
  UPSTREAM_TREE_DIGEST,
} from '../scripts/upstream-integrity.mjs'

test('upstream trust requires the locked commit and unchanged source tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowix-upstream-integrity-'))
  try {
    await writeFile(join(root, 'package.json'), '{}\n')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/index.ts'), 'export const value = 1\n')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules/generated.txt'), 'ignored dependency output\n')
    await mkdir(join(root, 'lib'))
    await writeFile(join(root, 'lib/generated.js'), 'ignored build output\n')
    await mkdir(join(root, 'dist-exe'))
    await writeFile(join(root, 'dist-exe/runtime'), 'ignored packaged output\n')
    await writeFile(join(root, 'tsconfig.tsbuildinfo'), 'ignored compiler output\n')

    const commit = 'a'.repeat(40)
    const patchDigest = 'b'.repeat(64)
    await writeFile(join(root, '.flowix-upstream-commit'), `${commit}\n`)
    await writeFile(join(root, UPSTREAM_TREE_DIGEST), `${await treeDigest(root)}\n`)
    await writeFile(join(root, UPSTREAM_PATCH_DIGEST), `${patchDigest}\n`)
    assert.equal(await isTrustedCheckout(root, commit, patchDigest), true)

    await writeFile(join(root, 'node_modules/generated.txt'), 'changed dependency output\n')
    await writeFile(join(root, 'lib/generated.js'), 'changed build output\n')
    await writeFile(join(root, 'dist-exe/runtime'), 'changed packaged output\n')
    await writeFile(join(root, 'tsconfig.tsbuildinfo'), 'changed compiler output\n')
    assert.equal(await isTrustedCheckout(root, commit, patchDigest), true)

    await writeFile(join(root, 'src/index.ts'), 'export const value = 2\n')
    assert.equal(await isTrustedCheckout(root, commit, patchDigest), false)
    assert.equal(await readFile(join(root, '.flowix-upstream-commit'), 'utf8'), `${commit}\n`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
