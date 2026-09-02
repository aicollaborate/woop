import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { __test, repairDshNativePackages, verifyDshNativePackages } from './dsh-native-deps.mjs'

test('repairs the exact wrapper/native version instead of the first pnpm candidate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flowix-dsh-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const runtime = join(root, 'runtime')
  const store = join(workspace, 'node_modules/.pnpm')
  await mkdir(join(store, 'node_modules'), { recursive: true })
  await writePackage(join(store, 'node_modules/koffi'), wrapperManifest('3.1.1'))
  await writePackage(join(store, '@koromix+koffi-darwin-arm64@3.0.0/node_modules/@koromix/koffi-darwin-arm64'), nativeManifest('3.0.0'), 'arm64')
  await writePackage(join(store, '@koromix+koffi-darwin-arm64@3.1.1/node_modules/@koromix/koffi-darwin-arm64'), nativeManifest('3.1.1'), 'arm64')
  await writePackage(join(runtime, 'node_modules/koffi'), wrapperManifest('0.0.0'))
  await writePackage(join(runtime, 'node_modules/@koromix/koffi-darwin-arm64'), nativeManifest('3.0.0'), 'x64')

  await repairDshNativePackages(runtime, workspace, { platform: 'darwin', arch: 'arm64' })
  const result = await verifyDshNativePackages(runtime, { platform: 'darwin', arch: 'arm64' })
  assert.equal(result.nativeVersion, '3.1.1')
  assert.equal(JSON.parse(await readFile(join(runtime, 'node_modules/koffi/package.json'))).version, '3.1.1')
})

test('rejects placeholders, version mismatches, and wrong native architectures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flowix-dsh-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime')
  await writePackage(join(runtime, 'node_modules/koffi'), wrapperManifest('3.1.1'))
  await writePackage(join(runtime, 'node_modules/@koromix/koffi-darwin-arm64'), nativeManifest('3.0.0'), 'arm64')
  await assert.rejects(
    verifyDshNativePackages(runtime, { platform: 'darwin', arch: 'arm64' }),
    /version mismatch/,
  )

  await writePackage(join(runtime, 'node_modules/@koromix/koffi-darwin-arm64'), nativeManifest('3.1.1'), 'x64')
  await assert.rejects(
    verifyDshNativePackages(runtime, { platform: 'darwin', arch: 'arm64' }),
    /no darwin\/arm64 \.node binary/,
  )

  await writePackage(join(runtime, 'node_modules/@koromix/koffi-darwin-arm64'), { _pnpmPlaceholder: true, name: '@koromix/koffi-darwin-arm64', version: '3.1.1' })
  await assert.rejects(
    verifyDshNativePackages(runtime, { platform: 'darwin', arch: 'arm64' }),
    /placeholder/,
  )
})

test('recognizes thin Mach-O, ELF, and PE target headers', () => {
  const macho = Buffer.alloc(16)
  macho.writeUInt32LE(0xfeedfacf, 0)
  macho.writeUInt32LE(0x0100000c, 4)
  assert.equal(__test.machOHasArchitecture(macho, 'arm64'), true)
  assert.equal(__test.machOHasArchitecture(macho, 'x64'), false)

  const elf = Buffer.alloc(24)
  elf.set([0x7f, 0x45, 0x4c, 0x46])
  elf.writeUInt16LE(183, 18)
  assert.equal(__test.elfHasArchitecture(elf, 'arm64'), true)

  const pe = Buffer.alloc(80)
  pe.set([0x4d, 0x5a])
  pe.writeUInt32LE(64, 0x3c)
  pe.set([0x50, 0x45, 0, 0], 64)
  pe.writeUInt16LE(0x8664, 68)
  assert.equal(__test.peHasArchitecture(pe, 'x64'), true)
})

function wrapperManifest(version) {
  return {
    name: 'koffi', version, main: './index.js',
    optionalDependencies: { '@koromix/koffi-darwin-arm64': '3.1.1' },
  }
}

function nativeManifest(version) {
  return { name: '@koromix/koffi-darwin-arm64', version, main: './index.js' }
}

async function writePackage(directory, manifest, architecture) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`)
  if (manifest._pnpmPlaceholder) return
  await writeFile(join(directory, 'index.js'), 'module.exports = require("./darwin_arm64/koffi.node")\n')
  const binary = Buffer.alloc(32)
  binary.writeUInt32LE(0xfeedfacf, 0)
  binary.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4)
  await mkdir(join(directory, 'darwin_arm64'), { recursive: true })
  await writeFile(join(directory, 'darwin_arm64/koffi.node'), binary)
}
