#!/usr/bin/env node
import { createInterface } from 'node:readline'

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fixture' } } })
    return
  }
  if (request.method === 'session/prompt') {
    const sessionId = request.params.sessionId
    const messageId = 'fixture-message-1'
    send({ jsonrpc: '2.0', id: request.id, result: { messageId } })
    setImmediate(() => {
      const event = payload => send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: payload } })
      event({ type: 'agent/inbox/spliced', seq: 1, time: 1, data: { inserted: [{ id: messageId }] } })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } })
      event({ type: 'assistant/chunk', seq: 2, time: 2, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } } })
      event({ type: 'assistant/chunk', seq: 3, time: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'hello' } } })
      event({ type: 'tool/call', seq: 4, time: 4, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"README.md"}' } })
      event({ type: 'tool/result', seq: 5, time: 5, data: {
        turn: 1, step: 1,
        message: { id: 'tool-message', role: 'user', source: { kind: 'tool', name: 'read' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }] },
      } })
      event({ type: 'assistant/chunk', seq: 6, time: 6, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } } } })
      event({ type: 'assistant/message', seq: 7, time: 7, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'hello' }] } } })
      event({ type: 'turn/end', seq: 8, time: 8, data: { turn: 1, reason: { kind: 'completed' } } })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } })
    })
    return
  }
  if (request.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: request.id, result: {} })
    setImmediate(() => process.exit(0))
  }
})

