import assert from 'node:assert/strict'
import { createHttpTransport } from '../src/http-transport.js'

const app = {
  dispatch: async request => ({ jsonrpc: '2.0', id: request.id, result: { method: request.method } }),
  subscribe: () => () => {},
  replayNotifications: async threadId => ({ data: [{ jsonrpc: '2.0', method: 'turn/started', params: { threadId, sourceSeq: 1 } }], nextCursor: null }),
}
const transport = createHttpTransport(app)
const address = await transport.listen()
const base = `http://127.0.0.1:${address.port}`
const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })
assert.equal(response.status, 200)
assert.equal((await response.json()).result.method, 'initialize')
assert.equal((await fetch(`${base}/readyz`)).status, 200)
assert.equal((await fetch(`${base}/healthz`)).status, 200)
assert.equal((await fetch(`${base}/healthz`, { headers: { origin: 'https://example.com' } })).status, 403)
const malformed = await fetch(`${base}/rpc`, { method: 'POST', body: '{' })
assert.equal((await malformed.json()).error.code, -32700)
const stream = await fetch(`${base}/events?threadId=thread-a&afterSeq=0`)
const reader = stream.body.getReader()
const firstChunk = new TextDecoder().decode((await reader.read()).value)
assert.match(firstChunk, /"method":"turn\/started"/)
assert.doesNotMatch(firstChunk, /"method":"item\/event"/)
await reader.cancel()
await transport.close()
console.log('http transport smoke: ok')
