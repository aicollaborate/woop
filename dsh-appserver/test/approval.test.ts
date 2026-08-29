import { describe, expect, it } from 'vitest'
import { AppServer } from '../src/index.js'

function adapter() {
  return {
    subscribe: () => () => {},
    startThread: async (id: string) => ({ id, status: 'idle', turns: [] }),
    findToolCall: async (_id: string, callId: string) => ({ seq: 7, type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify({ command: 'npm test', cwd: 'D:/project' }) } }),
    activeTurnId: (id: string) => `${id}-turn-1`,
    dispose: () => {},
  }
}

async function initializedServer(connectionId = 'client-a') {
  const server = new AppServer(null, { adapter: adapter() })
  const connection = server.createConnection(connectionId)
  await connection.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  await connection.dispatch({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { threadId: 'thread-a' } })
  return { server, connection }
}

describe('DSH approval bridge', () => {
  it('routes an owned request and resumes it from a JSON-RPC response', async () => {
    const { server, connection } = await initializedServer()
    const messages: any[] = []
    connection.subscribe(message => messages.push(message))
    const outcome = server.handleApproval({ agent: { session: { id: 'thread-a' } }, toolName: 'bash', callId: 'call-1', reason: 'needs escalation' }, async () => 'unavailable')
    await new Promise(resolve => setTimeout(resolve, 0))
    const request = messages.find(message => message.method === 'item/commandExecution/requestApproval')
    expect(request.params).toMatchObject({ threadId: 'thread-a', turnId: 'thread-a-turn-1', command: 'npm test', cwd: 'D:/project' })
    expect(connection.receive({ jsonrpc: '2.0', id: request.id, result: { decision: 'accept' } })).toMatchObject({ resolved: true, outcome: 'allowed-once' })
    await expect(outcome).resolves.toBe('allowed-once')
    expect(messages.at(-1)).toMatchObject({ method: 'serverRequest/resolved', params: { requestId: request.id } })
  })

  it('does not claim another channel owner\'s agent', async () => {
    const { server } = await initializedServer()
    await expect(server.handleApproval({ agent: { session: { id: 'other' } }, toolName: 'bash' }, async () => 'rejected')).resolves.toBe('rejected')
  })

  it('rejects a response from another connection', async () => {
    const { server, connection } = await initializedServer()
    const other = server.createConnection('client-b')
    await other.dispatch({ jsonrpc: '2.0', id: 10, method: 'initialize' })
    const messages: any[] = []
    connection.subscribe(message => messages.push(message))
    const outcome = server.handleApproval({ agent: { session: { id: 'thread-a' } }, toolName: 'bash' }, async () => 'unavailable')
    await new Promise(resolve => setTimeout(resolve, 0))
    const request = messages.find(message => message.id)
    expect(other.receive({ jsonrpc: '2.0', id: request.id, result: { decision: 'accept' } })).toMatchObject({ resolved: false, reason: 'not-owner' })
    connection.receive({ jsonrpc: '2.0', id: request.id, result: { decision: 'decline' } })
    await expect(outcome).resolves.toBe('rejected')
  })

  it('cancels a pending request when its DSH signal aborts', async () => {
    const { server, connection } = await initializedServer()
    connection.subscribe(() => {})
    const controller = new AbortController()
    const outcome = server.handleApproval({ agent: { session: { id: 'thread-a' } }, toolName: 'bash', signal: controller.signal }, async () => 'unavailable')
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(outcome).resolves.toBe('cancelled')
  })

  it('accepts split-transport responses through serverRequest/respond', async () => {
    const { server, connection } = await initializedServer()
    const messages: any[] = []
    connection.subscribe(message => messages.push(message))
    const outcome = server.handleApproval({ agent: { session: { id: 'thread-a' } }, toolName: 'bash' }, async () => 'unavailable')
    await new Promise(resolve => setTimeout(resolve, 0))
    const request = messages.find(message => message.id)
    const response = await connection.dispatch({ jsonrpc: '2.0', id: 20, method: 'serverRequest/respond', params: { requestId: request.id, decision: 'accept' } })
    expect(response.result).toMatchObject({ resolved: true, outcome: 'allowed-once' })
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('replays only live pending requests after a same-generation reconnect', async () => {
    const { server, connection } = await initializedServer()
    connection.subscribe(() => {})
    const outcome = server.handleApproval({ agent: { session: { id: 'thread-a' } }, toolName: 'bash' }, async () => 'unavailable')
    await new Promise(resolve => setTimeout(resolve, 0))
    server.disconnectConnection('client-a', 1000)
    server.reconnectConnection('client-a')
    const pending = server.pendingServerRequests('client-a', 'thread-a')
    expect(pending).toHaveLength(1)
    connection.receive({ jsonrpc: '2.0', id: pending[0].id, result: { decision: 'decline' } })
    await expect(outcome).resolves.toBe('rejected')
    expect(server.pendingServerRequests('client-a', 'thread-a')).toEqual([])
  })
})
