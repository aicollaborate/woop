export function stableTurnId(threadId, turn) { return `${threadId}-turn-${turn}` }
export function stableItemId(threadId, event) { return `${threadId}-item-${event.data?.id || event.data?.messageId || event.seq}` }

export function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value?.text === 'string') return value.text
  if (value?.message) return textOf(value.message)
  if (Array.isArray(value?.content)) return value.content.map(block => typeof block === 'string' ? block : block?.text || '').join('')
  if (typeof value?.content === 'string') return value.content
  return JSON.stringify(value)
}

export function messageFromEvent(threadId, event, toolNames = undefined) {
  if (event.type === 'tool/call' || event.type === 'tool/result') {
    const data = event.data || {}
    const callId = data.callId || data.toolCallId || data.id || data.message?.source?.callId
    const result = event.type === 'tool/result'
      ? (data.message?.content ?? data.result ?? data.content ?? data)
      : undefined
    const input = event.type === 'tool/call' ? (data.arguments ?? data.input) : undefined
    return {
      id: String(callId || `${threadId}-tool-${event.seq}`),
      role: 'tool',
      content: textOf(result ?? input ?? data),
      llmContent: null,
      systemReminderDirectory: null,
      sourceSeq: Number(event.seq),
      timestamp: eventTimestamp(event),
      sourceSequence: Number(event.seq),
      isLoading: false,
      toolCallId: callId ? String(callId) : null,
      toolName: data.name || data.toolName || toolNames?.get?.(String(callId)) || null,
      toolData: result === undefined ? null : textOf(result),
      toolInput: input ?? null,
      toolCalls: null,
      reasoning: null,
      isCompleted: event.type === 'tool/result',
      errorDetails: null,
      isCollapsed: null,
      codexTurnId: null,
    }
  }
  const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined
  if (!role) return undefined
  const payload = role === 'assistant' ? event.data?.message ?? event.data : event.data
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  const toolCalls = blocks.filter(block => block?.type === 'tool-call')
  let content = blocks.length ? blocks.filter(block => block?.type === 'text').map(block => block.text || '').join('') : textOf(payload)
  if (role === 'user') {
    if (content.startsWith('<system-reminder>') || content.startsWith('Current runtime context.')) return undefined
    content = content.split('\n<## CONTEXT PROMPT ##>')[0]
  }
  if (!content.trim() && !toolCalls.length) return undefined
  return {
    id: String(payload?.id || `${threadId}-message-${event.seq}`),
    role,
    content,
    llmContent: null,
    systemReminderDirectory: null,
    sourceSeq: Number(event.seq),
    timestamp: eventTimestamp(event),
    sourceSequence: Number(event.seq),
    isLoading: false,
    toolCallId: null,
    toolName: null,
    toolData: null,
    toolInput: null,
    toolCalls: toolCalls.length ? toolCalls : null,
    reasoning: null,
    isCompleted: true,
    errorDetails: null,
    isCollapsed: null,
    codexTurnId: null,
  }
}

function eventTimestamp(event) {
  const value = event.time ?? event.timestamp ?? event.createdAt
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return ''
}

// `assistant/chunk` is a transport event, not a display message. Its payload
// contains pi-ai protocol control blocks (block-start/end, reasoning-delta,
// usage and finish) as well as user-visible text-delta blocks. Never pass the
// envelope through textOf(): doing so serializes the whole protocol object and
// leaks it into the conversation UI.
export function assistantChunkText(value) {
  const chunk = value?.chunk
  if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return undefined
  return chunk.text
}

export function itemFromEvent(threadId, event, toolNames = undefined) {
  const types = { 'user/message': 'userMessage', 'assistant/message': 'agentMessage', 'tool/call': 'toolCall', 'tool/result': 'toolResult', 'approval/asked': 'approvalRequest', 'approval/decided': 'approvalRequest' }
  const type = types[event.type]
  if (!type) return undefined
  if (event.type === 'approval/asked') return { id: stableItemId(threadId, event), type, sourceSeq: event.seq, status: 'inProgress', toolName: event.data?.toolName, callId: event.data?.callId, reason: event.data?.reason }
  if (event.type === 'approval/decided') return { id: stableItemId(threadId, event), type, sourceSeq: event.seq, status: 'completed', outcome: event.data?.outcome }
  const data = event.data || {}
  if (event.type === 'tool/call') {
    return {
      id: stableItemId(threadId, event), type, sourceSeq: event.seq,
      callId: data.callId || data.id, toolName: data.name || data.toolName,
      input: data.arguments ?? data.input ?? {}, text: textOf(data.arguments ?? data.input ?? {}),
    }
  }
  if (event.type === 'tool/result') {
    const message = data.message || {}
    const callId = data.callId || data.toolCallId || data.id || message.source?.callId
    return {
      id: stableItemId(threadId, event), type, sourceSeq: event.seq,
      callId, toolName: data.name || data.toolName || toolNames?.get?.(String(callId)),
      result: message.content ?? data.result ?? data.content ?? data,
      text: textOf(message.content ?? data.result ?? data.content ?? data),
    }
  }
  return { id: stableItemId(threadId, event), type, sourceSeq: event.seq, text: textOf(data) }
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
  const toolNames = new Map()
  for (const event of events || []) {
    if (event.type !== 'tool/call') continue
    const callId = event.data?.callId || event.data?.id
    const name = event.data?.name || event.data?.toolName
    if (callId && name) toolNames.set(String(callId), String(name))
  }
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
    const item = itemFromEvent(threadId, event, toolNames)
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
      const delta = assistantChunkText(event.data)
      // Reasoning and protocol/control chunks are intentionally not emitted on
      // the ordinary assistant-text channel. The desktop has a separate
      // reasoning stream, while control chunks have no user-visible content.
      if (delta !== undefined) {
        notifications.push({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId: activeTurnId, itemId: stableItemId(threadId, event), sourceSeq: event.seq, delta } })
      }
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
