import type { HarnessAdapter, Json, RpcNotification, Thread, Turn, TurnPage } from './types.js'

/** Small in-memory adapter for protocol smoke tests. Replace with DSH adapter in production. */
export class InMemoryHarnessAdapter implements HarnessAdapter {
  private readonly threads = new Map<string, Thread>()
  private readonly listeners = new Set<(event: RpcNotification) => void>()

  async startThread(threadId: string): Promise<Thread> {
    const thread: Thread = { id: threadId, status: 'idle', turns: [] }
    this.threads.set(threadId, thread)
    return structuredClone(thread)
  }

  async resumeThread(threadId: string): Promise<Thread> {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    return structuredClone(thread)
  }

  async forkThread(sourceId: string, _boundarySeq?: number, childId = `thread-${Date.now()}`): Promise<Thread> {
    const source = this.threads.get(sourceId)
    if (!source) throw new Error(`Thread not found: ${sourceId}`)
    const child: Thread = { ...structuredClone(source), id: childId, parentThreadId: sourceId }
    this.threads.set(childId, child)
    return structuredClone(child)
  }

  async readThread(threadId: string, includeTurns: boolean): Promise<Thread> {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    return includeTurns ? structuredClone(thread) : { ...structuredClone(thread), turns: [] }
  }

  async listThreads(): Promise<Thread[]> { return [...this.threads.values()].map(thread => structuredClone(thread)) }
  async listTurns(threadId: string, cursor = '0', limit = 50): Promise<TurnPage> {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    const start = Math.max(0, Number.parseInt(cursor, 10) || 0)
    const data = thread.turns.slice(start, start + limit).map(turn => structuredClone(turn))
    const next = start + data.length < thread.turns.length ? String(start + data.length) : null
    return { data, nextCursor: next }
  }
  async listEvents(threadId: string, afterSeq = -1, limit = 200) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    const events = thread.turns.flatMap(turn => turn.items.map(item => ({ seq: item.sourceSeq ?? 0, type: item.type, data: { text: item.text ?? null } })))
      .filter(event => event.seq > afterSeq).slice(0, limit)
    return { data: events, nextCursor: null }
  }

  async startTurn(threadId: string, input: Json): Promise<Turn> {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    const turn: Turn = { id: `turn-${Date.now()}`, threadId, status: 'completed', items: [{ id: `item-${Date.now()}`, type: 'userMessage', text: JSON.stringify(input) }] }
    thread.turns.push(turn)
    this.emit({ jsonrpc: '2.0', method: 'session.status', params: { threadId, status: 'idle' } })
    return structuredClone(turn)
  }

  async interruptTurn(_threadId: string): Promise<{ interrupted: boolean }> { return { interrupted: false } }
  async closeThread(threadId: string): Promise<{ closed: boolean }> { return { closed: this.threads.delete(threadId) } }
  subscribe(listener: (event: RpcNotification) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(event: RpcNotification): void { for (const listener of this.listeners) listener(event) }
}
