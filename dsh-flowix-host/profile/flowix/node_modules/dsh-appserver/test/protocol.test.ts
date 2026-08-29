import { describe, expect, it } from 'vitest'
import { AppServer, InMemoryHarnessAdapter } from '../src/index.js'

describe('dsh-appserver protocol', () => {
  it('requires initialize before thread operations', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    const result = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'thread/list' })
    expect(result.error?.code).toBe(-32002)
  })

  it('supports thread start, turn, read, fork and paged turns', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { threadId: 'root' } })
    await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: 'root', input: 'hello' } })
    const fork = await server.dispatch({ jsonrpc: '2.0', id: 4, method: 'thread/fork', params: { threadId: 'root', newThreadId: 'child' } })
    const read = await server.dispatch({ jsonrpc: '2.0', id: 5, method: 'thread/read', params: { threadId: 'child' } })
    const page = await server.dispatch({ jsonrpc: '2.0', id: 6, method: 'thread/turns/list', params: { threadId: 'root', limit: 1 } })
    expect(fork.error).toBeUndefined()
    expect((read.result as { thread: { parentThreadId?: string } }).thread.parentThreadId).toBe('root')
    expect((page.result as { page: { data: unknown[] } }).page.data).toHaveLength(1)
  })

  it('forwards App Server launch context when creating a thread', async () => {
    let launch: Record<string, unknown> | undefined
    const adapter = {
      subscribe: () => () => {},
      emit: () => {},
      startThread: async (_threadId: string, config: Record<string, unknown>) => {
        launch = config
        return { id: 'root', status: 'idle', turns: [] }
      },
    }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const result = await server.dispatch({
      jsonrpc: '2.0', id: 2, method: 'thread/start',
      params: {
        threadId: 'root', cwd: '/workspace', workspacePaths: ['/workspace', '/notes'],
        provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096,
        agentPreset: 'standard', permissionMode: 'workspace-write',
      },
    })
    expect(result.error).toBeUndefined()
    expect(launch).toEqual({
      cwd: '/workspace', workspacePaths: ['/workspace', '/notes'],
      provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096,
      agentPreset: 'standard', permissionMode: 'workspace-write',
    })
  })

  it('rejects duplicate initialize and malformed params', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const duplicate = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'initialize' })
    const invalid = await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'thread/read', params: [] })
    expect(duplicate.error?.code).toBe(-32003)
    expect(invalid.error?.code).toBe(-32602)
  })

  it('serializes one thread while allowing different threads to run concurrently', async () => {
    let active = 0
    let maxActive = 0
    const adapter = {
      subscribe: () => () => {},
      readThread: async (threadId: string) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active--
        return { id: threadId, status: 'idle', turns: [] }
      },
    }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    await Promise.all([
      server.dispatch({ jsonrpc: '2.0', id: 2, method: 'thread/read', params: { threadId: 'a' } }),
      server.dispatch({ jsonrpc: '2.0', id: 3, method: 'thread/read', params: { threadId: 'b' } }),
    ])
    expect(maxActive).toBe(2)
    maxActive = 0
    await Promise.all([
      server.dispatch({ jsonrpc: '2.0', id: 4, method: 'thread/read', params: { threadId: 'a' } }),
      server.dispatch({ jsonrpc: '2.0', id: 5, method: 'thread/read', params: { threadId: 'a' } }),
    ])
    expect(maxActive).toBe(1)
  })

  it('tracks initialize state per connection', async () => {
    const server = new AppServer(null, { adapter: new InMemoryHarnessAdapter() })
    const first = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 'client-a')
    const second = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'initialize' }, 'client-b')
    const duplicate = await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'initialize' }, 'client-a')
    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    expect(duplicate.error?.code).toBe(-32003)
  })

  it('applies notification opt-out per connection', async () => {
    const listeners = new Set<(event: { method: string }) => void>()
    const adapter = { subscribe: (listener: (event: { method: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { optOutNotificationMethods: ['warning'] } } }, 'client-a')
    const received: string[] = []
    server.subscribeConnection('client-a', (event: { method: string }) => received.push(event.method))
    for (const listener of listeners) listener({ method: 'warning' })
    for (const listener of listeners) listener({ method: 'turn/started' })
    expect(received).toEqual(['turn/started'])
  })
})
