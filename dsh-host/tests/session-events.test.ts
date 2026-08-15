import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptSessionEvent, endReasonFromNotifications } from '../src/adapter/session-events.ts'

test('maps text, reasoning and usage chunks', () => {
  assert.deepEqual(adaptSessionEvent({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hi' } } }), [
    { type: 'assistant.delta', text: 'hi' },
  ])
  assert.deepEqual(adaptSessionEvent({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'why' } } }), [
    { type: 'reasoning.delta', text: 'why' },
  ])
  assert.deepEqual(adaptSessionEvent({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } } } }), [
    { type: 'usage', inputTokens: 3, outputTokens: 4 },
  ])
})

test('maps authoritative tool events', () => {
  assert.deepEqual(adaptSessionEvent({
    type: 'tool/call', data: { callId: 'call-1', name: 'read', arguments: '{"path":"a"}' },
  }), [{ type: 'tool.started', id: 'call-1', name: 'read', input: { path: 'a' } }])
  assert.deepEqual(adaptSessionEvent({
    type: 'tool/result',
    data: { message: { source: { name: 'read' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }] } },
  }), [{ type: 'tool.completed', id: 'call-1', name: 'read', result: 'ok' }])
})

test('maps terminal turn reason', () => {
  assert.equal(endReasonFromNotifications([{
    method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } } },
  }]), 'max_tokens')
})

