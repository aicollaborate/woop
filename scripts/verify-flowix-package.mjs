#!/usr/bin/env node

// Verify that a Flowix updater artifact is self-contained and does not carry
// the separately downloadable DSH runtime or DSH UI packages.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const artifact = process.argv[2]
if (!artifact || !existsSync(artifact)) {
  console.error('usage: node scripts/verify-flowix-package.mjs <artifact>')
  process.exit(2)
}

const listing = listArchive(artifact)
const forbidden = [
  /(?:^|[/\\])dsh-host(?:\.exe)?$/iu,
  /(?:^|[/\\])dsh-host-spawn-helper(?:\.exe)?$/iu,
  /dsh-flowix-memory/iu,
  /dsh-web-ui/iu,
  /dsh-client-ui-/iu,
]
const matches = listing.filter((entry) => forbidden.some((pattern) => pattern.test(entry)))
if (matches.length > 0) {
  console.error(`ERROR: Flowix artifact contains DSH files: ${matches.join(', ')}`)
  process.exit(1)
}

console.log(`==> Verified Flowix artifact excludes DSH: ${basename(artifact)}`)

function listArchive(file) {
  if (/\.tar\.gz$/iu.test(file)) return run('tar', ['-tzf', file])
  if (/\.zip$/iu.test(file)) return run('unzip', ['-Z1', file])
  if (/\.exe$/iu.test(file)) {
    const sevenZip = process.env.SEVEN_ZIP
      || (process.platform === 'win32' ? 'C:/Program Files/7-Zip/7z.exe' : '7z')
    return run(sevenZip, ['l', '-ba', resolve(file)])
  }
  if (/\.AppImage$/iu.test(file)) {
    console.error('ERROR: AppImage is not an updater archive; verify its extracted staging directory instead.')
    process.exit(2)
  }
  console.error(`ERROR: unsupported Flowix artifact format: ${file}`)
  process.exit(2)
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    console.error(`ERROR: failed to list ${fileLabel(command)}: ${result.stderr || result.error || result.status}`)
    process.exit(1)
  }
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
}

function fileLabel(command) {
  return command === 'tar' ? 'tar archive' : 'zip archive'
}
