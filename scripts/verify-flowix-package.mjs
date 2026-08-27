#!/usr/bin/env node

// Verify that a Flowix updater artifact is self-contained and does not carry
// the separately downloadable DSH runtime or DSH UI packages.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

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
  if (/\.dmg$/iu.test(file)) return listDmg(file)
  console.error(`ERROR: unsupported Flowix artifact format: ${file}`)
  process.exit(2)
}

function listDmg(file) {
  const mountPoint = mkdtempSync(join(tmpdir(), 'flowix-dmg-'))
  const attached = spawnSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, file], {
    encoding: 'utf8',
  })
  if (attached.error || attached.status !== 0) {
    rmSync(mountPoint, { recursive: true, force: true })
    console.error(`ERROR: failed to mount DMG: ${attached.stderr || attached.error || attached.status}`)
    process.exit(1)
  }
  try {
    return walk(mountPoint).map((entry) => entry.slice(mountPoint.length + 1))
  } finally {
    const detached = spawnSync('hdiutil', ['detach', mountPoint], { encoding: 'utf8' })
    rmSync(mountPoint, { recursive: true, force: true })
    if (detached.error || detached.status !== 0) {
      console.error(`ERROR: failed to detach DMG: ${detached.stderr || detached.error || detached.status}`)
      process.exit(1)
    }
  }
}

function walk(directory) {
  const entries = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    entries.push(path)
    if (entry.isDirectory()) entries.push(...walk(path))
  }
  return entries
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
