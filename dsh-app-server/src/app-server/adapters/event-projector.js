export function stableTurnId(threadId, turn) { return `${threadId}-turn-${turn}` }
export function stableItemId(threadId, event) { return `${threadId}-item-${event.data?.id || event.data?.messageId || event.seq}` }

export function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value?.text === 'string') return value.text
  if (Array.isArray(value?.content)) return value.content.map(block => typeof block === 'string' ? block : block?.text || '').join('')
  if (typeof value?.content === 'string') return value.content
  return JSON.stringify(value)
}

export function itemFromEvent(threadId, event) {
  const types = { 'user/message': 'userMessage', 'assistant/message': 'agentMessage', 'tool/call': 'toolCall', 'tool/result': 'toolResult', 'approval/asked': 'approvalRequest', 'approval/decided': 'approvalRequest' }
  const type = types[event.type]
  if (!type) return undefined
  if (event.type === 'approval/asked') return { id: stableItemId(threadId, event), type, sourceSeq: event.seq, status: 'inProgress', toolName: event.data?.toolName, callId: event.data?.callId, reason: event.data?.reason }
  if (event.type === 'approval/decided') return { id: stableItemId(threadId, event), type, sourceSeq: event.seq, status: 'completed', outcome: event.data?.outcome }
  return { id: stableItemId(threadId, event), type, sourceSeq: event.seq, text: textOf(event.data) }
}

export function turnEndStatus(data) {
  const reason = data?.reason?.kind || data?.reason || data?.status
  const value = String(reason || '')
  if (value.includes('cancel') || value.includes('abort') || value.includes('interrupt') || value.includes('disposed')) return 'interrupted'
  if (value.includes('fail') || value.includes('error')) return 'failed'
  return 'completed'
}

export function projectTurns(threadId, events, fallbackMessages = []) {
  const turns = []
  const byNumber = new Map()
  let current
  for (const event of events || []) {
    const number = event.data?.turn
    if (event.type === 'turn/start') {
      current = { id: stableTurnId(threadId, number ?? event.seq), threadId, status: 'inProgress', items: [], sourceTurn: number }
      turns.push(current)
      if (number != null) byNumber.set(number, current)
      continue
    }
    const target = number != null ? byNumber.get(number) || current : current
    const item = itemFromEvent(threadId, event)
    if (item && target) {
      const previous = target.items.findIndex(existing => existing.id === item.id)
      if (previous >= 0) target.items[previous] = { ...target.items[previous], ...item }
      else target.items.push(item)
    }
    if (event.type === 'turn/end' && target) {
      target.status = turnEndStatus(event.data)
      current = undefined
    }
  }
  if (turns.length) return turns.map(({ sourceTurn: _sourceTurn, ...turn }) => turn)
  if (!fallbackMessages.length) return []
  return [{
    id: `${threadId}-turn-history`, threadId, status: 'completed',
    items: fallbackMessages.map((message, index) => ({
      id: `item-${threadId}-${index}`,
      type: message.role === 'user' ? 'userMessage' : 'agentMessage',
      text: textOf(message), sourceSeq: index,
    })),
  }]
}

export function projectNotifications(threadId, events) {
  const notifications = []
  let activeTurnId
  for (const event of events || []) {
    const number = event.data?.turn
    if (event.type === 'turn/start') {
      activeTurnId = stableTurnId(threadId, number ?? event.seq)
      notifications.push({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turnId: activeTurnId, sourceSeq: event.seq, turn: { id: activeTurnId, threadId, status: 'inProgress', items: [] } } })
      continue
    }
    if (event.type === 'assistant/chunk') {
      notifications.push({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId: activeTurnId, itemId: stableItemId(threadId, event), sourceSeq: event.seq, delta: textOf(event.data) } })
      continue
    }
    const item = itemFromEvent(threadId, event)
    if (item) {
      const params = { threadId, turnId: activeTurnId, sourceSeq: event.seq, item }
      notifications.push({ jsonrpc: '2.0', method: 'item/started', params })
      if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'approval/decided') notifications.push({ jsonrpc: '2.0', method: 'item/completed', params })
    }
    if (event.type === 'turn/end') {
      const turnId = activeTurnId || stableTurnId(threadId, number ?? event.seq)
      notifications.push({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId, sourceSeq: event.seq, turn: { id: turnId, threadId, status: turnEndStatus(event.data), items: [] } } })
      activeTurnId = undefined
    }
  }
  return notifications
}
