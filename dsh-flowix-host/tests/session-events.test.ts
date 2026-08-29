import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptSessionEvent,
  endReasonFromNotifications,
  failureFromNotifications,
  materializeSessionHistory,
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
    data: { message: { source: { toolName: 'read' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }] } },
  }), [{ type: 'tool.completed', id: 'call-1', name: 'read', result: 'ok' }])
})

test('keeps the Harness toolResult source toolName instead of falling back to tool', () => {
  assert.deepEqual(adaptSessionEvent({
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', toolName: 'todo_write', callId: 'call-plan' },
        content: [{ type: 'tool-result', toolCallId: 'call-plan', content: [] }],
      },
    },
  }), [{ type: 'tool.completed', id: 'call-plan', name: 'todo_write', result: [] }])
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

test('materializes persisted DSH events into stable display messages', () => {
  const page = materializeSessionHistory([
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2000, surfaceOp: 'append', data: { id: 'user-1', source: { kind: 'user', flowixDisplayText: 'hello', flowixClientMessageId: 'client-1' }, content: [{ type: 'text', text: 'hidden workspace context' }] } },
    { type: 'assistant/chunk', seq: 3, time: 3000, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'think' } } },
    { type: 'tool/call', seq: 4, time: 4000, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"README.md"}' } },
    { type: 'assistant/message', seq: 5, time: 5000, surfaceOp: 'append', sourceEventSeqs: [3, 4], data: { turn: 1, step: 1, message: { id: 'assistant-1', source: { kind: 'model' }, content: [{ type: 'text', text: 'first' }] } } },
    { type: 'tool/result', seq: 6, time: 6000, surfaceOp: 'append', data: { turn: 1, step: 1, message: { source: { kind: 'tool', toolName: 'read' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }] } } },
    { type: 'assistant/message', seq: 7, time: 7000, surfaceOp: 'append', data: { turn: 1, step: 2, message: { id: 'assistant-2', source: { kind: 'model' }, content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 8, time: 8000, data: { turn: 1, reason: { kind: 'completed' } } },
  ], undefined, 50, 8)
  const messages = page.messages
  assert.deepEqual(messages.map(message => ({ role: message.role, content: message.content, loading: message.isLoading })), [
    { role: 'user', content: 'hello', loading: undefined },
    { role: 'reasoning', content: 'think', loading: undefined },
    { role: 'assistant', content: 'first', loading: undefined },
    { role: 'tool', content: 'ok', loading: false },
    { role: 'assistant', content: 'done', loading: undefined },
  ])
  assert.deepEqual(messages[3]?.toolInput, { path: 'README.md' })
  assert.equal(messages[0]?.id, 'client-1')
  assert.equal(messages[2]?.sourceSequence, 5)
  assert.equal(messages[4]?.sourceSequence, 7)
  assert.equal(page.snapshotSequence, 8)
})
