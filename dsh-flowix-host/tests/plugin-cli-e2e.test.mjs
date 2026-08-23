import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const cli = resolve(root, 'vendor/deepseek-harness/apps/cli/lib/bin.js')
const fixture = resolve(root, 'tests/fixtures/community-bundle')
const memoryBundle = resolve(root, '..', 'dsh-flowix-memory')
const tooling = resolve(root, 'scripts/tooling')
const required = [
  '@deepseek-ai/dsh-base',
  '@flowix/dsh-flowix-bridge',
  'dsh-flowix-memory',
]

test('official plugin CLI preserves Flowix layers and mounts a third-party bundle', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'flowix-dsh-plugin-e2e-'))
  const home = join(temporary, 'home')
  const profile = join(home, 'profiles', 'flowix')
  try {
    await cp(resolve(root, 'profile/flowix'), profile, { recursive: true })
    await cp(memoryBundle, join(profile, 'node_modules', 'dsh-flowix-memory'), {
      recursive: true,
    })
    const env = {
      ...process.env,
      DSH_HOME: home,
      PATH: `${tooling}${delimiter}${process.env.PATH ?? ''}`,
    }
    run(['plugin', '--profile', 'flowix', 'add', fixture], env)
    let manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [...required, 'dsh-community-fixture'])

    const dump = run(['--profile', 'flowix', '--dump-config'], env)
    assert.match(dump, /# == dsh-community-fixture/)
    assert.match(dump, /id: community-fixture/)

    run(['plugin', '--profile', 'flowix', 'remove', 'dsh-community-fixture'], env)
    manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, required)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

function run(args, env) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
