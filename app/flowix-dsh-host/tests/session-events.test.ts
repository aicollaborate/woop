import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptSessionEvent,
  endReasonFromNotifications,
  failureFromNotifications,
} from '../src/adapter/session-events.ts'

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

test('maps the assistant source model and preserves cache read/write fields', () => {
  assert.deepEqual(adaptSessionEvent({
    type: 'assistant/message',
    data: {
      message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
      usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 2 },
    },
  }), [{
    type: 'usage',
    modelId: 'deepseek-chat',
    inputTokens: 12,
    outputTokens: 4,
    cacheReadTokens: 8,
    cacheWriteTokens: 2,
  }])
})

test('can suppress streamed usage when the caller reads one session snapshot', () => {
  assert.deepEqual(adaptSessionEvent({
    type: 'assistant/chunk',
    data: { chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } } },
  }, { includeUsage: false }), [])
  assert.deepEqual(adaptSessionEvent({
    type: 'assistant/message',
    data: {
      message: { source: { model: 'deepseek-chat' } },
      usage: { inputTokens: 3, outputTokens: 4 },
    },
  }, { includeUsage: false }), [])
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

test('does not turn a notification stream without turn/end into a silent success', () => {
  assert.equal(endReasonFromNotifications([]), 'protocol_error')
})

test('preserves terminal Harness failure details', () => {
  assert.deepEqual(failureFromNotifications([{
    method: 'session.event',
    params: {
      event: {
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { message: 'Request timed out.', code: 'TIMEOUT' },
          },
        },
      },
    },
  }]), { message: 'Request timed out.', code: 'TIMEOUT' })
})

test('falls back to the assistant finish failure when turn end is unavailable', () => {
  assert.deepEqual(failureFromNotifications([{
    method: 'session.event',
    params: {
      event: {
        type: 'assistant/chunk',
        data: {
          chunk: {
            type: 'finish',
            reason: { kind: 'error', failure: { message: 'bad gateway', code: 'SERVER' } },
          },
        },
      },
    },
  }]), { message: 'bad gateway', code: 'SERVER' })
})
