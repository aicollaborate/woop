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
})
