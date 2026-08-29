import { NativeDshAdapter } from './adapters/native-dsh-adapter.js'
import { createMethodRegistry } from './methods/index.js'
import { assertRequest, ErrorCode, failure, paramsOf, RpcError, success } from './protocol/json-rpc.js'
import { serveStdio } from './transports/stdio.js'
import { ApprovalManager } from './approvals/approval-manager.js'

const SERVER_INFO = Object.freeze({ name: 'dsh-appserver', version: '0.2.0' })
const APP_SERVER_PROTOCOL_VERSION = 1

export class DshAppServer {
  constructor(ctx, { maxQueuedRequests = 1024, adapter } = {}) {
    this.adapter = adapter || new NativeDshAdapter(ctx)
    this.approvals = new ApprovalManager({
      inspectToolCall: (threadId, callId) => this.adapter.findToolCall?.(threadId, callId),
      activeTurnId: threadId => this.adapter.activeTurnId?.(threadId),
    })
    this.disposers = new Set()
    this.connections = new Map()
    this.maxQueuedRequests = maxQueuedRequests
    this.queuedRequests = 0
    this.queues = new Map()
    this.methods = createMethodRegistry(this.adapter, (method, params) => this.adapter.emit({ jsonrpc: '2.0', method, params }))
  }

  subscribe(listener) { return this.adapter.subscribe(listener) }
  subscribeConnection(connectionId, listener) {
    const unsubscribeAdapter = this.adapter.subscribe(event => {
      const state = this.connections.get(connectionId)
      if (!state?.optOut?.has(event.method)) listener(event)
    })
    const unsubscribeApprovals = this.approvals.subscribe((target, event) => {
      if (target === connectionId && !this.connections.get(connectionId)?.optOut?.has(event.method)) listener(event)
    })
    return () => { unsubscribeAdapter(); unsubscribeApprovals() }
  }
  shouldNotify(connectionId, event) { return !this.connections.get(connectionId)?.optOut?.has(event.method) }
  reconnectConnection(connectionId) { return this.approvals.reconnect(connectionId) }
  disconnectConnection(connectionId, graceMs = 5000) { return this.approvals.disconnect(connectionId, graceMs) }
  pendingServerRequests(connectionId, threadId) { return this.approvals.listPending(connectionId, threadId) }
  createConnection(connectionId = `connection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
    return {
      id: connectionId,
      dispatch: request => this.dispatch(request, connectionId),
      receive: response => this.receiveResponse(response, connectionId),
      subscribe: listener => this.subscribeConnection(connectionId, listener),
      pending: threadId => this.approvals.listPending(connectionId, threadId),
      close: ({ graceMs = 0 } = {}) => { this.approvals.disconnect(connectionId, graceMs); this.connections.delete(connectionId) },
    }
  }
  listEvents(threadId, afterSeq = -1, limit = 200) { return this.adapter.listEvents(threadId, afterSeq, limit) }
  replayNotifications(threadId, afterSeq = -1, limit = 200) { return this.adapter.replayNotifications(threadId, afterSeq, limit) }

  dispatch(request, connectionId = 'default') {
    if (this.queuedRequests >= this.maxQueuedRequests) return Promise.resolve(failure(request?.id ?? null, 'Server overloaded; retry later.', -32001))
    this.queuedRequests++
    const queueKey = this.queueKey(request)
    const previous = this.queues.get(queueKey) || Promise.resolve()
    const operation = previous.then(() => this.dispatchNow(request, connectionId))
    const tail = operation.catch(() => undefined).finally(() => {
      this.queuedRequests--
      if (this.queues.get(queueKey) === tail) this.queues.delete(queueKey)
    })
    this.queues.set(queueKey, tail)
    return operation
  }

  queueKey(request) {
    const params = request?.params
    const threadId = params && typeof params === 'object' && !Array.isArray(params) ? params.threadId || params.sessionId : undefined
    return typeof threadId === 'string' && threadId ? `thread:${threadId}` : 'global'
  }

  async dispatchNow(request, connectionId) {
    try {
      assertRequest(request)
      if (request.method === 'initialize') {
        if (this.connections.has(connectionId)) throw new RpcError(ErrorCode.alreadyInitialized, 'Already initialized')
        const requestedVersion = request.params?.protocolVersion
        if (requestedVersion !== undefined && requestedVersion !== APP_SERVER_PROTOCOL_VERSION) {
          throw new RpcError(ErrorCode.invalidParams, `Unsupported App Server protocol version: ${String(requestedVersion)}`)
        }
        const optOut = request.params?.capabilities?.optOutNotificationMethods
        const generation = this.approvals.connect(connectionId)
        this.connections.set(connectionId, { generation, optOut: new Set(Array.isArray(optOut) ? optOut.filter(value => typeof value === 'string') : []) })
        return success(request.id, {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          capabilities: {
            threads: true, turns: true, fork: true, history: true, interrupt: true,
            models: { list: true, configure: true, delete: true },
            credentials: { read: true, write: true },
            flowix: { jobs: true, usage: true, plugins: true, profile: true },
            approvals: { request: true, policy: ['ask', 'never'], decisions: ['accept', 'decline', 'cancel'] },
          },
        })
      }
      if (request.method === 'shutdown') return success(request.id, {})
      if (!this.connections.has(connectionId)) throw new RpcError(ErrorCode.notInitialized, 'Not initialized')
      if (request.method === 'serverRequest/respond') {
        const params = paramsOf(request)
        if (typeof params.requestId !== 'string' || !params.requestId) throw new RpcError(ErrorCode.invalidParams, 'requestId must be a non-empty string')
        const result = this.approvals.resolve(connectionId, params.requestId, params.decision)
        if (!result.resolved) throw new RpcError(ErrorCode.invalidParams, `Approval request cannot be resolved: ${result.reason}`)
        return success(request.id, result)
      }
      const params = paramsOf(request)
      const threadId = params.threadId || params.sessionId
      if (typeof threadId === 'string' && ['thread/start', 'thread/resume', 'turn/start'].includes(request.method)) this.approvals.acquire(threadId, connectionId)
      const handler = this.methods.get(request.method)
      if (!handler) throw new RpcError(ErrorCode.methodNotFound, `Unknown method: ${request.method}`)
      return success(request.id, await handler(params, { connectionId }))
    } catch (error) {
      if (error instanceof RpcError) return failure(request?.id ?? null, error.message, error.code, error.data)
      return failure(request?.id ?? null, error instanceof Error ? error.message : String(error))
    }
  }

  receiveResponse(response, connectionId = 'default') {
    if (!response || typeof response !== 'object' || response.id === undefined || response.method !== undefined) return { resolved: false, reason: 'invalid-response' }
    return this.approvals.resolveResponse(connectionId, response)
  }

  addDisposer(disposer) { if (typeof disposer === 'function') this.disposers.add(disposer); return disposer }

  handleApproval(request, next) { return this.approvals.handle(request, next) }

  serveStdio(input = process.stdin, output = process.stdout) { return serveStdio(this, input, output) }
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const disposer of this.disposers) disposer()
    this.disposers.clear()
    this.approvals.dispose()
    await this.adapter.dispose()
  }
}

// Backward-compatible class name for existing consumers.
export { DshAppServer as NativeJsonRpcServer }
