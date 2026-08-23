import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')

function read(relative: string): string {
  return readFileSync(resolve(root, relative), 'utf8')
}

const SHARED_NEEDLES = [
  "id: dsh-flowix-memory",
  "name: '@deepseek-ai/dsh-mcp-client'",
  'serverName: dsh-flowix-memory',
  'transport: stdio',
] as const

test('memory stays an independent profile bundle and is not duplicated in the host composition', () => {
  const product = read('config/flowix.cordis.yml')
  const bridge = read('profile/flowix/node_modules/@flowix/dsh-flowix-bridge/cordis.patch.yml')
  const patch = read('../dsh-flowix-memory/cordis.patch.yml')
  const packageManifest = JSON.parse(read('../dsh-flowix-memory/package.json'))

  for (const needle of SHARED_NEEDLES) {
    assert.ok(patch.includes(needle), `bundle patch missing ${needle}`)
    assert.ok(!product.includes(needle), `product composition duplicates independent bundle row ${needle}`)
  }
  const profile = JSON.parse(read('profile/flowix/package.json'))
  assert.equal(profile.dsh.profile.bundles[0], '@deepseek-ai/dsh-base')
  assert.match(product, /\[\]\s*$/)
  assert.doesNotMatch(product, /sdk-jsonrpc-server|flowix-dsh-bridge/)
  assert.match(bridge, /id: sdk-jsonrpc-server/)
  assert.match(bridge, /id: flowix-dsh-bridge/)
  assert.ok(profile.dsh.profile.bundles.includes('dsh-flowix-memory'))
  assert.match(patch, /FLOWIX_DSH_MCP_CLI/)
  assert.match(patch, /FLOWIX_CLI_PATH/)
  assert.match(patch, /launcher\.mjs/)
  assert.ok(packageManifest.files.includes('launcher.mjs'))
})

test('Flowix profile keeps the headless non-interactive runtime boundary', () => {
  const patch = read('profile/flowix/cordis.patch.yml')

  for (const plugin of ['typert', 'typert-loader', 'typert-gateway', 'session-title-llm']) {
    assert.match(patch, new RegExp(`id: ${plugin}\\n  disabled: true`))
  }
  assert.match(patch, /policy: never/)
  assert.match(patch, /defaultPreset: !!js process\.env\.DSH_PERMISSION_MODE/)
  assert.equal((patch.match(/approval: never/g) ?? []).length, 3)
})
