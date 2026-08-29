import { presentApproval } from './approval-presenter.js'

const VALID_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

export class ApprovalManager {
  constructor({ inspectToolCall, activeTurnId, timeoutMs = 120000 } = {}) {
    this.inspectToolCall = inspectToolCall
    this.activeTurnId = activeTurnId
    this.timeoutMs = timeoutMs
    this.nextRequestId = 1
    this.connections = new Map()
    this.leases = new Map()
    this.pending = new Map()
    this.listeners = new Set()
    this.disconnectTimers = new Map()
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(connectionId, message) { for (const listener of this.listeners) listener(connectionId, message) }

  connect(connectionId) {
    const timer = this.disconnectTimers.get(connectionId)
    if (timer) { clearTimeout(timer); this.disconnectTimers.delete(connectionId) }
    const current = this.connections.get(connectionId)
    if (current?.connected) return current.generation
    const generation = (current?.generation || 0) + 1
    this.connections.set(connectionId, { generation, connected: true })
    return generation
  }

  reconnect(connectionId) {
    const timer = this.disconnectTimers.get(connectionId)
    if (timer) { clearTimeout(timer); this.disconnectTimers.delete(connectionId) }
    const current = this.connections.get(connectionId)
    if (!current) return this.connect(connectionId)
    current.connected = true
    return current.generation
  }

  acquire(threadId, connectionId) {
    const generation = this.connect(connectionId)
    this.leases.set(String(threadId), { connectionId, generation })
  }

  owns(threadId) { return this.leases.has(String(threadId)) }

  disconnect(connectionId, graceMs = 0) {
    const state = this.connections.get(connectionId)
    if (state) state.connected = false
    const settle = () => {
      this.disconnectTimers.delete(connectionId)
      for (const pending of [...this.pending.values()]) {
        if (pending.connectionId === connectionId && pending.generation === state?.generation) this.settle(pending, 'unavailable')
      }
    }
    if (graceMs > 0) this.disconnectTimers.set(connectionId, setTimeout(settle, graceMs))
    else settle()
  }

  async handle(request, next = () => Promise.resolve('unavailable')) {
    const threadId = String(request.agent?.session?.id ?? '')
    const lease = this.leases.get(threadId)
    if (!threadId || !lease) return next()
    const connection = this.connections.get(lease.connectionId)
    if (!connection?.connected || connection.generation !== lease.generation) return 'unavailable'

    const requestId = `approval:${this.nextRequestId++}`
    let toolCall
    try { toolCall = await this.inspectToolCall?.(threadId, request.callId) } catch { /* presentation enrichment is optional */ }
    const presented = presentApproval(request, toolCall)
    const turnId = this.activeTurnId?.(threadId) ?? null
    const itemId = toolCall ? `${threadId}-item-${toolCall.data?.id || toolCall.data?.messageId || toolCall.seq}` : null
    return new Promise(resolve => {
      const pending = {
        requestId, threadId, turnId, itemId,
        connectionId: lease.connectionId,
        generation: lease.generation,
        resolve,
        signal: request.signal,
      }
      pending.timer = setTimeout(() => this.settle(pending, 'unavailable'), this.timeoutMs)
      if (request.signal) {
        pending.onAbort = () => this.settle(pending, 'cancelled')
        request.signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      pending.requestMessage = {
        jsonrpc: '2.0', id: requestId, method: presented.method,
        params: { requestId, threadId, turnId, itemId, kind: presented.kind, ...presented.details },
      }
      this.pending.set(requestId, pending)
      this.emit(lease.connectionId, pending.requestMessage)
    })
  }

  resolve(connectionId, requestId, decision) {
    const pending = this.pending.get(String(requestId))
    if (!pending) return { resolved: false, reason: 'not-found' }
    const state = this.connections.get(connectionId)
    if (pending.connectionId !== connectionId || pending.generation !== state?.generation) return { resolved: false, reason: 'not-owner' }
    const outcome = this.mapDecision(decision)
    this.settle(pending, outcome)
    return { resolved: true, outcome }
  }

  resolveResponse(connectionId, response) {
    const decision = response?.result?.decision
    if (response?.error) return this.resolve(connectionId, response.id, 'cancel')
    return this.resolve(connectionId, response?.id, decision)
  }

  mapDecision(decision) {
    const value = typeof decision === 'object' ? decision?.decision : decision
    if (value === 'accept' || value === 'approved' || value === 'allow' || value === 'allowed-once') return 'allowed-once'
    if (value === 'decline' || value === 'deny' || value === 'rejected') return 'rejected'
    if (value === 'cancel' || value === 'cancelled') return 'cancelled'
    if (VALID_OUTCOMES.has(value)) return value
    return 'unavailable'
  }

  settle(pending, outcome) {
    if (!this.pending.delete(pending.requestId)) return
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener?.('abort', pending.onAbort)
    pending.resolve(outcome)
    this.emit(pending.connectionId, {
      jsonrpc: '2.0', method: 'serverRequest/resolved',
      params: { threadId: pending.threadId, requestId: pending.requestId },
    })
  }

  listPending(connectionId, threadId) {
    const state = this.connections.get(connectionId)
    return [...this.pending.values()]
      .filter(item => item.connectionId === connectionId && item.generation === state?.generation && (!threadId || item.threadId === threadId))
      .map(item => item.requestMessage)
      .filter(Boolean)
  }

  dispose() {
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer)
    for (const pending of [...this.pending.values()]) this.settle(pending, 'unavailable')
    this.listeners.clear()
  }
}
