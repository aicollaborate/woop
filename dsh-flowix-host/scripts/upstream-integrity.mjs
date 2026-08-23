import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export const UPSTREAM_TREE_DIGEST = '.flowix-upstream-tree-sha256'
export const UPSTREAM_PATCH_DIGEST = '.flowix-upstream-patches-sha256'

/**
 * Hash the generated source tree without including dependency closures or
 * the integrity metadata itself. The generated checkout intentionally has no
 * .git directory, so this is the content-level proof used on later builds.
 */
export async function treeDigest(root) {
  const hash = createHash('sha256')
  await visit(root, root, hash)
  return hash.digest('hex')
}

export async function patchSetDigest(hostRoot, lock) {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({
    repository: lock.repository,
    commit: lock.commit,
    patches: lock.patches,
  }))
  for (const patch of lock.patches) {
    hash.update(patch)
    hash.update(await readFile(join(hostRoot, patch)))
  }
  return hash.digest('hex')
}

export async function isTrustedCheckout(root, requestedCommit, expectedPatchDigest) {
  const markerPath = join(root, '.flowix-upstream-commit')
  const digestPath = join(root, UPSTREAM_TREE_DIGEST)
  const patchDigestPath = join(root, UPSTREAM_PATCH_DIGEST)
  try {
    const [marker, expectedDigest, patchDigest] = await Promise.all([
      readFile(markerPath, 'utf8'),
      readFile(digestPath, 'utf8'),
      readFile(patchDigestPath, 'utf8'),
    ])
    if (marker.trim().toLowerCase() !== requestedCommit.toLowerCase()) return false
    if (patchDigest.trim().toLowerCase() !== expectedPatchDigest.toLowerCase()) return false
    return (await treeDigest(root)) === expectedDigest.trim().toLowerCase()
  } catch {
    return false
  }
}

async function visit(root, directory, hash) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (entry.name === 'node_modules'
      || entry.name === '.git'
      || entry.name === 'lib'
      || entry.name === 'dist'
      || entry.name === 'dist-exe'
      || entry.name.endsWith('.tsbuildinfo')
      || entry.name === '.flowix-upstream-commit'
      || entry.name === UPSTREAM_TREE_DIGEST
      || entry.name === UPSTREAM_PATCH_DIGEST) continue
    const path = join(directory, entry.name)
    const name = relative(root, path).split(sep).join('/')
    // The runtime builder stages a large, platform-specific closure here.
    // It is a build product, not part of the locked upstream source tree.
    if (name === 'python/sdk-runtime/src') continue
    const info = await lstat(path)
    if (info.isDirectory()) {
      hash.update(`dir\0${name}\0${info.mode & 0o777}\0`)
      await visit(root, path, hash)
    } else if (info.isSymbolicLink()) {
      hash.update(`link\0${name}\0${await readlink(path)}\0`)
    } else if (info.isFile()) {
      hash.update(`file\0${name}\0${info.mode & 0o777}\0`)
      hash.update(await readFile(path))
    } else {
      throw new Error(`unsupported upstream filesystem entry: ${path}`)
    }
  }
}
