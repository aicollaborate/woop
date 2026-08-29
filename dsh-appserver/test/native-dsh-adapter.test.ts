import { describe, expect, it } from 'vitest'
import { NativeDshAdapter } from '../src/app-server/adapters/native-dsh-adapter.js'

describe('NativeDshAdapter thread launch', () => {
  it('creates a configured agent with its preset and permission', async () => {
    let options: Record<string, any> | undefined
    const mounted: string[] = []
    const permissions: string[] = []
    const agent = {
      status: 'idle',
      session: { id: 'thread-1', events: [], header: {}, deriveMessages: () => [] },
    }
    const ctx = {
      on: () => () => {},
      agents: {
        create: async (value: Record<string, any>) => {
          options = value
          return { agent, dispose: async () => {} }
        },
        get: () => undefined,
      },
      get: (name: string) => {
        if (name === 'agentPresets') return { mount: async (_ctx: unknown, preset: string) => { mounted.push(preset) } }
        if (name === 'permissionPresets') return { set: (_session: unknown, preset: string) => { permissions.push(preset) } }
        return undefined
      },
    }
    const adapter = new NativeDshAdapter(ctx)

    await adapter.startThread('thread-1', {
      cwd: '/workspace', workspacePaths: ['/workspace', '/notes'],
      provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096,
      agentPreset: 'standard', permissionMode: 'workspace-write',
    })

    expect(options?.sessionId).toBe('thread-1')
    expect(options?.meta).toEqual({ cwd: '/workspace', agentPreset: 'standard', workspacePaths: ['/workspace', '/notes'] })
    expect(options?.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 })
    await options?.setup({})
    expect(mounted).toEqual(['standard'])
    expect(permissions).toEqual(['workspace-write'])
  })

  it('projects real persisted DSH messages and usage', async () => {
    const events = [
      { type: 'request/context', seq: 1, time: 100, data: { provider: 'minimax-cn', model: 'MiniMax-M3', contextWindow: 1000000 } },
      { type: 'user/message', seq: 2, time: 101, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/chunk', seq: 3, time: 102, data: { chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 11 } } } },
      { type: 'assistant/message', seq: 4, time: 103, data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 11 } } },
    ]
    const ctx = {
      on: () => () => {},
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence' ? { inspect: async () => ({ events }) } : undefined,
    }
    const adapter = new NativeDshAdapter(ctx)
    await expect(adapter.sessionHistory('session-1')).resolves.toMatchObject({
      sessionId: 'session-1',
      messages: [
        expect.objectContaining({ id: 'u1', role: 'user', content: 'hello', sourceSeq: 2 }),
        expect.objectContaining({ id: 'a1', role: 'assistant', content: 'hi', sourceSeq: 4 }),
      ],
      snapshotSequence: 4,
    })
    await expect(adapter.sessionUsage('session-1')).resolves.toEqual({
      sessionId: 'session-1', modelId: 'MiniMax-M3', inputTokens: 7, outputTokens: 3,
      cacheReadTokens: 11, cacheWriteTokens: 0, contextTokens: null, contextWindow: 1000000,
    })
  })
})
