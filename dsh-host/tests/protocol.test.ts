import assert from 'node:assert/strict'
import test from 'node:test'
import { ProtocolInputError, requireRuntimeSpec } from '../src/protocol/validation.ts'
import { sessionPoolOptions } from '../src/runtime/pool-options.ts'

test('runtime spec is strict and fail closed', () => {
  assert.deepEqual(requireRuntimeSpec({
    threadId: 't', sessionId: 's', cwd: '/tmp', provider: 'flowix', providerName: 'MiniMax',
    workspacePaths: ['/tmp', '/tmp/extra', '/tmp'],
    apiProtocol: 'openai-completions', baseUrl: 'https://example.test/v1',
    model: 'deepseek-v4-flash', permissionMode: 'workspace-write',
  }), {
    threadId: 't', sessionId: 's', cwd: '/tmp', provider: 'flowix', providerName: 'MiniMax',
    workspacePaths: ['/tmp', '/tmp/extra'], apiProtocol: 'openai-completions',
    baseUrl: 'https://example.test/v1', model: 'deepseek-v4-flash', agentPreset: 'standard',
    permissionMode: 'workspace-write',
  })
  assert.deepEqual(requireRuntimeSpec({
    threadId: 't', sessionId: 's', cwd: '/tmp', provider: 'flowix', providerName: 'MiniMax',
    apiProtocol: 'openai-completions', baseUrl: 'https://example.test/v1',
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
