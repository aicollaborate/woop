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

test('external bundle patch stays in sync with the embedded Flowix composition', () => {
  const product = read('config/flowix.cordis.yml')
  const patch = read('bundles/dsh-flowix-memory/cordis.patch.yml')

  for (const needle of SHARED_NEEDLES) {
    assert.ok(product.includes(needle), `product composition missing ${needle}`)
    assert.ok(patch.includes(needle), `bundle patch missing ${needle}`)
  }

  // The command source differs by design: the product host injects the
  // bundled sidecar path; the external bundle falls back to the PATH binary.
  assert.match(product, /FLOWIX_DSH_MCP_CLI/)
  assert.match(patch, /FLOWIX_CLI_PATH/)
})
