import { describe, expect, it } from 'vitest'
import { NativeDshAdapter } from '../src/app-server/adapters/native-dsh-adapter.js'

describe('NativeDshAdapter thread launch', () => {
  it('returns the grouped plugin catalog shape expected by Flowix', () => {
    const adapter = new NativeDshAdapter({
      get: (name: string) => name === 'plugins' ? { list: () => ['dsh-appserver'] } : undefined,
    })

    expect(adapter.listPlugins()).toEqual({
      plugins: {
        platform: process.platform,
        host: [{
          key: 'host:0:dsh-appserver', id: 'dsh-appserver', name: 'dsh-appserver',
          enabled: true, toggleable: false, scope: 'host',
        }],
        presets: {},
        profile: [],
      },
    })
  })

  it('reads plugins from the Cordis registry when no plugin service is exposed', () => {
    const adapter = new NativeDshAdapter({
      registry: { values: () => [{ name: 'dsh-appserver' }] },
    })

    expect(adapter.listPlugins().plugins.host.map((plugin: { id: string }) => plugin.id)).toEqual(['dsh-appserver'])
  })

  it('uses the loader inventory instead of Cordis runtime records', () => {
    const adapter = new NativeDshAdapter({
      get: (name: string) => name === 'pluginInventory'
        ? { list: () => ({ entries: [
          { entryId: 'entry-1', moduleName: '@deepseek-ai/dsh-tool-web', enabled: true, fiberPhase: 'active' },
          { entryId: 'entry-2', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: false, fiberPhase: null },
        ] }) }
        : name === 'plugins'
          ? { list: () => [{ callback: () => {}, fibers: [] }] }
        : undefined,
    })

    expect(adapter.listPlugins().plugins.host).toEqual([
      {
        key: 'host:0:entry-1', id: '@deepseek-ai/dsh-tool-web', name: '@deepseek-ai/dsh-tool-web',
        enabled: true, toggleable: false, scope: 'host',
      },
      {
        key: 'host:1:entry-2', id: '@deepseek-ai/dsh-tool-fs', name: '@deepseek-ai/dsh-tool-fs',
        enabled: false, toggleable: false, scope: 'host',
      },
    ])
  })

  it('projects configured loader rows and omits Cordis groups', () => {
    const adapter = new NativeDshAdapter({
      loader: {
        entries: () => [
          { options: { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }, disabled: false },
          { options: { id: 'tools', name: 'cordis:group', group: true }, disabled: false },
          { options: { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }, disabled: true },
        ],
      },
    })

    expect(adapter.listPlugins().plugins.host).toEqual([
      {
        key: 'host:0:tool-web', id: 'tool-web', name: '@deepseek-ai/dsh-tool-web',
        enabled: true, toggleable: false, scope: 'host',
      },
      {
        key: 'host:1:tool-fs', id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs',
        enabled: false, toggleable: false, scope: 'host',
      },
    ])
  })

  it('forks after the assistant message only after closing its turn', async () => {
    const sourceEvents = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { id: 'a1', content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 5, data: { turn: 2 } },
    ]
    let seed: unknown[] | undefined
    const childAgent = { session: { id: 'child', events: [], header: {}, deriveMessages: () => [] } }
    const ctx = {
      on: () => () => {},
      sessions: { get: (id: string) => id === 'source' ? { id, events: sourceEvents, header: {} } : undefined },
      agents: {
        create: async (options: Record<string, unknown>) => {
          seed = options.seed as unknown[]
          return { agent: childAgent, dispose: async () => {} }
        },
        get: () => undefined,
      },
    }
    const adapter = new NativeDshAdapter(ctx)

    await adapter.forkThread('source', 3, 'child')

    expect(seed?.map(event => (event as { seq: number }).seq)).toEqual([1, 2, 3, 4])
  })

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

  it('returns one readable tool message for persisted call and result events', async () => {
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'inspect' }] } },
      { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"file_path":"a.txt"}' } },
      { type: 'tool/result', seq: 4, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'alpha' }] }], role: 'user', id: 'r1' } } },
    ]
    const adapter = new NativeDshAdapter({
      on: () => () => {}, agents: { get: () => undefined }, sessions: { get: () => undefined },
      get: (name: string) => name === 'sessionPersistence' ? { inspect: async () => ({ events }) } : undefined,
    })

    const result = await adapter.sessionHistory('session-1')
    expect(result.messages.filter(message => message.role === 'tool')).toHaveLength(1)
    expect(result.messages[1]).toMatchObject({
      id: 'call-1', content: 'alpha', toolData: 'alpha',
      toolInput: { file_path: 'a.txt' }, isCompleted: true,
    })
  })

})
