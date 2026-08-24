import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProtocolInputError,
  requireModelDiscover,
  requireModelResolve,
  requireRequest,
  requireRunStart,
  requireRuntimeSpec,
  requireSessionUsage,
  requireSessionHistory,
  requireThread,
  requireThreadRun,
} from '../src/protocol/validation.ts'
import { sessionPoolOptions } from '../src/runtime/pool-options.ts'

test('JSON-RPC request validation uses the invalid-request protocol code', () => {
  assert.throws(() => requireRequest({}), error => {
    assert.ok(error instanceof ProtocolInputError)
    assert.equal(error.code, -32600)
    assert.equal(error.message, 'invalid JSON-RPC request')
    return true
  })
  assert.deepEqual(requireRequest({ jsonrpc: '2.0', id: 'request-1', method: 'host.ping' }), {
    jsonrpc: '2.0', id: 'request-1', method: 'host.ping',
  })
})

test('malformed JSON-RPC envelopes fail with -32600', () => {
  const invalidEnvelopes = [
    undefined,
    null,
    [],
    {},
    { jsonrpc: '1.0', id: 1, method: 'host.ping' },
    { jsonrpc: '2.0', id: null, method: 'host.ping' },
    { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: 1, method: 42 },
  ]
  for (const envelope of invalidEnvelopes) {
    assert.throws(() => requireRequest(envelope), error => {
      assert.ok(error instanceof ProtocolInputError)
      assert.equal(error.code, -32600)
      return true
    })
  }
})

test('method parameter validators consistently fail with -32602', () => {
  const invalidParams = [
    ['runtime.ensure', () => requireRuntimeSpec({})],
    ['run.start', () => requireRunStart({})],
    ['run.cancel', () => requireThreadRun({})],
    ['runtime.dispose', () => requireThread({})],
    ['session.usage', () => requireSessionUsage({})],
    ['session.history', () => requireSessionHistory({})],
    ['models.discover', () => requireModelDiscover({ api: 'invalid' })],
    ['models.resolve', () => requireModelResolve({})],
  ] as const
  for (const [method, validate] of invalidParams) {
    assert.throws(validate, error => {
      assert.ok(error instanceof ProtocolInputError, method)
      assert.equal(error.code, -32602, method)
      return true
    })
  }
})

test('session history pagination is bounded and cursor-safe', () => {
  assert.deepEqual(requireSessionHistory({ sessionId: 's', beforeSequence: 12, snapshotSequence: 20, limit: 999 }), {
    sessionId: 's', beforeSequence: 12, snapshotSequence: 20, limit: 50,
  })
  assert.throws(() => requireSessionHistory({ sessionId: 's', beforeSequence: -1, limit: 1 }), ProtocolInputError)
})

test('runtime spec is strict and fail closed', () => {
  assert.deepEqual(requireRuntimeSpec({
    threadId: 't', sessionId: 's', cwd: '/tmp', provider: 'minimax', providerName: 'MiniMax',
    workspacePaths: ['/tmp', '/tmp/extra', '/tmp'], apiKeyEnv: 'MINIMAX_API_KEY',
    apiProtocol: 'openai-completions', baseUrl: 'https://example.test/v1',
    model: 'deepseek-v4-flash', permissionMode: 'workspace-write',
  }), {
    threadId: 't', sessionId: 's', cwd: '/tmp', provider: 'minimax', providerName: 'MiniMax',
    workspacePaths: ['/tmp', '/tmp/extra'], apiProtocol: 'openai-completions', apiKeyEnv: 'MINIMAX_API_KEY',
    baseUrl: 'https://example.test/v1', model: 'deepseek-v4-flash', agentPreset: 'standard',
    permissionMode: 'workspace-write',
  })
  assert.deepEqual(requireRuntimeSpec({
    threadId: 't', sessionId: 's', cwd: '/tmp', provider: 'minimax', providerName: 'MiniMax',
    apiProtocol: 'openai-completions', apiKeyEnv: 'MINIMAX_API_KEY', baseUrl: 'https://example.test/v1',
    model: 'deepseek-v4-flash', agentPreset: 'code', permissionMode: 'workspace-write',
  }).agentPreset, 'code')
  assert.throws(() => requireRuntimeSpec({
    threadId: 't', sessionId: 's', cwd: '/tmp', provider: 'p', providerName: 'p',
    apiProtocol: 'openai-completions', baseUrl: 'https://example.test/v1',
    model: 'm', permissionMode: 'yolo',
  }), ProtocolInputError)
  assert.throws(() => requireRuntimeSpec({
    threadId: 't', sessionId: 's', cwd: '/tmp', provider: 'p', providerName: 'p',
    apiProtocol: 'openai-completions', baseUrl: 'https://example.test/v1',
    model: 'm', agentPreset: 'unsupported', permissionMode: 'read-only',
  }), ProtocolInputError)
})

test('runtime retention settings are configurable and fail loud', () => {
  assert.deepEqual(sessionPoolOptions({
    FLOWIX_DSH_MAX_IDLE_RUNTIMES: '0',
    FLOWIX_DSH_IDLE_TTL_MS: '1500',
  }), { maxIdleRuntimes: 0, idleTtlMs: 1500 })
  assert.throws(() => sessionPoolOptions({ FLOWIX_DSH_IDLE_TTL_MS: '-1' }))
})

test('runtime spec preserves the native llm-pi-ai provider route', () => {
  assert.equal(requireRuntimeSpec({
    threadId: 't', sessionId: 's', cwd: '/tmp', provider: 'deepseek', providerName: 'DeepSeek',
    apiProtocol: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat', permissionMode: 'read-only',
  }).provider, 'deepseek')
})

test('protocol 1 accepts additive request fields from newer Flowix clients', () => {
  const spec = requireRuntimeSpec({
    threadId: 't', cwd: '/tmp', provider: 'deepseek', providerName: 'DeepSeek',
    apiProtocol: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat', permissionMode: 'read-only',
    futureOptionalField: { enabled: true },
  })
  assert.equal(spec.threadId, 't')
  assert.equal('futureOptionalField' in spec, false)
})
