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
  "args: ['mcp']",
] as const

test('memory stays an independent profile bundle and is not duplicated in the host composition', () => {
  const product = read('config/flowix.cordis.yml')
  const bridge = read('profile/flowix/node_modules/@flowix/dsh-flowix-bridge/cordis.patch.yml')
  const patch = read('bundles/dsh-flowix-memory/cordis.patch.yml')

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
})
