import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

const launcher = resolve(import.meta.dirname, '../../dsh-flowix-memory/launcher.mjs')

test('memory launcher keeps memo available when Flowix CLI is missing', async () => {
  const child = spawn(process.execPath, [launcher], {
    env: {
      PATH: '',
      HOME: process.env.HOME ?? '',
      FLOWIX_CLI_PATH: '/definitely-missing/flowix-cli',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    for (const line of String(chunk).split(/\r?\n/u)) if (line.trim() !== '') lines.push(line)
  })
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const next = async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const line = lines.shift()
      if (line !== undefined) return JSON.parse(line) as Record<string, any>
      await new Promise(resolveWait => setTimeout(resolveWait, 10))
    }
    throw new Error(`timed out waiting for launcher response: ${JSON.stringify(lines)}`)
  }
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    assert.equal((await next()).id, 1)
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const list = await next()
    assert.equal(list.result.tools[0].name, 'memo')
    assert.ok(list.result.tools[0].inputSchema.properties.action.enum.includes('create'))
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memo', arguments: { command: 'notebooks' } } })
    const call = await next()
    assert.equal(call.result.isError, true)
    assert.match(call.result.content[0].text, /Flowix CLI is unavailable/u)
    assert.match(call.result.content[0].text, /https:\/\/flowix-memo\.com\/latest\.json/u)
  } finally {
    child.kill()
  }
})
