import type { HistoryMessage, HostEvent, RunEndReason } from '../protocol/v1.ts'
import type { FlowixDshBridgeEvent } from '../bridge/protocol.ts'
import { isRecord } from '../protocol/validation.ts'
import { deriveEventMessage, isAppendSurfaceEvent } from '../../vendor/deepseek-harness/packages/core/session/src/surface.ts'
import type { SessionEvent } from '../../vendor/deepseek-harness/packages/core/session/src/types.ts'

export interface RunFailure {
  message: string
  code?: string
}

export interface HarnessNotificationAdaptOptions {
  /** Include provider usage samples from the stream; false when the caller reads one session snapshot after the turn. */
  includeUsage?: boolean
}

export function adaptHarnessNotification(
  notification: unknown,
  options: HarnessNotificationAdaptOptions = {},
): HostEvent[] {
  if (!isRecord(notification) || notification.method !== 'session.event') return []
  const params = notification.params
  if (!isRecord(params) || !isRecord(params.event)) return []
  return adaptSessionEvent(params.event, options)
}

/**
 * Adapt the DSH-native event envelope emitted by the DSH bridge (delivered
 * by the dsh-appserver bundle in this profile).
 *
 * This deliberately shares the same session-event adapter as the SDK
 * compatibility notification. The bridge is the preferred event path, while
 * the SDK notification remains a fallback for older profiles/runtimes.
 */
export function adaptFlowixBridgeEvent(
  bridgeEvent: FlowixDshBridgeEvent,
  options: HarnessNotificationAdaptOptions = {},
): HostEvent[] {
  if (bridgeEvent.kind !== 'session.event' || !isRecord(bridgeEvent.event)) return []
  return adaptSessionEvent(bridgeEvent.event, options)
}

export function adaptSessionEvent(
  event: Record<string, unknown>,
  options: HarnessNotificationAdaptOptions = {},
): HostEvent[] {
  const data = event.data
  if (!isRecord(data)) return []
  switch (event.type) {
    case 'assistant/chunk':
      return adaptStreamChunk(data.chunk, options)
    case 'tool/call': {
      const id = stringValue(data.callId)
      const name = stringValue(data.name)
      if (id === undefined || name === undefined) return []
      return [{ type: 'tool.started', id, name, input: parseJsonOrString(data.arguments) }]
    }
    case 'tool/result': {
      const message = data.message
      if (!isRecord(message) || !Array.isArray(message.content)) return []
      const block = message.content.find(item => isRecord(item) && item.type === 'tool-result')
      if (!isRecord(block)) return []
      const id = stringValue(block.toolCallId)
      if (id === undefined) return []
      return [{
        type: 'tool.completed',
        id,
        name: toolName(message.source),
        result: contentResult(block.content),
        ...(block.isError === true || data.error !== undefined ? { isError: true } : {}),
      }]
    }
    case 'assistant/message':
      return options.includeUsage === false ? [] : adaptUsage(data.usage, modelIdFromMessage(data.message))
    default:
      return []
  }
}

/**
 * Build the human transcript from DSH's append-origin durable surface.
 * Replacement surface nodes are model-context rewrites, while append-origin
 * nodes are explicitly the messages the user already saw. Raw text chunks are
 * never treated as assistant history; only reasoning chunks referenced by a
 * finalized assistant message are projected alongside that message.
 */
export function materializeSessionHistory(
  events: Array<Record<string, unknown>>,
  beforeTurnSeq: number | undefined,
  turnLimit: number,
  snapshotSeq: number,
): { messages: HistoryMessage[]; oldestSequence: number | null; hasMore: boolean; snapshotSequence: number } {
  const bounded = events.filter(event => Number.isSafeInteger(event.seq) && Number(event.seq) <= snapshotSeq)
  const allTurnStarts = bounded
    .filter(event => event.type === 'turn/start')
    .map(event => Number(event.seq))
  const completedTurnStarts = allTurnStarts.filter((start, index) => {
    const nextStart = allTurnStarts[index + 1] ?? Number.MAX_SAFE_INTEGER
    return bounded.some(event => event.type === 'turn/end'
      && Number(event.seq) > start && Number(event.seq) < nextStart)
  })
  const turnStarts = completedTurnStarts.filter(start => beforeTurnSeq === undefined || start < beforeTurnSeq)
  const selectedStarts = turnStarts.slice(-Math.max(1, Math.min(turnLimit, 50)))
  const oldestSequence = selectedStarts[0] ?? null
  if (oldestSequence === null) {
    return { messages: [], oldestSequence: null, hasMore: false, snapshotSequence: snapshotSeq }
  }
  const newestSelected = selectedStarts.at(-1)!
  const followingTurn = allTurnStarts.find(start => start > newestSelected)
  const upperBound = Math.min(beforeTurnSeq ?? Number.MAX_SAFE_INTEGER, followingTurn ?? Number.MAX_SAFE_INTEGER)
  const selected = bounded.filter(event => Number(event.seq) >= oldestSequence && Number(event.seq) < upperBound)
  const messages: HistoryMessage[] = []
  const tools = new Map<string, number>()
  const bySequence = new Map(bounded.map(event => [Number(event.seq), event]))
  const appendTool = (source: Record<string, unknown> | undefined): void => {
    if (source?.type !== 'tool/call' || !isRecord(source.data)) return
    const id = stringValue(source.data.callId)
    if (id === undefined || tools.has(id)) return
    const name = stringValue(source.data.name) ?? 'tool'
    tools.set(id, messages.length)
    messages.push({ id: `dsh-history:tool:${id}`, role: 'tool', content: '', timestamp: eventTimestamp(source),
      isLoading: true, isCompleted: false, toolCallId: id, toolName: name,
      toolInput: parseJsonOrString(source.data.arguments) })
  }

  for (const event of selected) {
    const data = isRecord(event.data) ? event.data : undefined
    switch (event.type) {
      case 'user/message': {
        if (!isAppendSurfaceEvent(event as SessionEvent) || data === undefined
          || !isRecord(data.source) || data.source.kind !== 'user') break
        const projected = deriveEventMessage(event as SessionEvent)
        if (projected === null) break
        const source: Record<string, unknown> = isRecord(projected.source) ? projected.source : {}
        const content = stringValue(source.flowixDisplayText) ?? messageText(projected as unknown as Record<string, unknown>)
        if (content === '') break
        messages.push({ id: stringValue(source.flowixClientMessageId) ?? String(projected.id), role: 'user', content,
          timestamp: eventTimestamp(event), isCompleted: true })
        break
      }
      case 'assistant/message': {
        if (!isAppendSurfaceEvent(event as SessionEvent)) break
        const reasoning = sourceSequences(event)
          .map(sequence => bySequence.get(sequence))
          .flatMap(source => reasoningText(source))
          .join('')
        if (reasoning !== '') {
          messages.push({ id: `dsh-history:reasoning:${event.seq}`, role: 'reasoning', content: reasoning,
            timestamp: eventTimestamp(event), isCompleted: true })
        }
        const projected = deriveEventMessage(event as SessionEvent)
        if (projected === null) break
        const content = messageText(projected as unknown as Record<string, unknown>)
        if (content !== '') {
          messages.push({ id: String(projected.id), role: 'assistant', content,
            timestamp: eventTimestamp(event), sourceSequence: Number(event.seq),
            isCompleted: data?.interrupted !== true })
        }
        for (const sequence of sourceSequences(event)) appendTool(bySequence.get(sequence))
        break
      }
      case 'tool/result': {
        if (!isAppendSurfaceEvent(event as SessionEvent) || data === undefined
          || !isRecord(data.message) || !Array.isArray(data.message.content)) break
        const block = data.message.content.find(item => isRecord(item) && item.type === 'tool-result')
        if (!isRecord(block)) break
        const id = stringValue(block.toolCallId)
        if (id === undefined) break
        for (const sequence of sourceSequences(event)) appendTool(bySequence.get(sequence))
        const result = contentResult(block.content)
        const content = typeof result === 'string' ? result : JSON.stringify(result)
        const index = tools.get(id)
        if (index !== undefined) {
          const message = messages[index]!
          message.content = content
          message.toolData = content
          message.isLoading = false
          message.isCompleted = true
        }
        break
      }
      case 'turn/end': {
        if (data === undefined || !isRecord(data.reason) || data.reason.kind !== 'error') break
        const failure = normalizeFailure(data.reason.error, 'DeepSeek Harness turn failed')
        messages.push({ id: `dsh-history:error:${event.seq}`, role: 'assistant',
          content: failure.code === undefined ? failure.message : `[${failure.code}] ${failure.message}`,
          timestamp: eventTimestamp(event), isCompleted: true })
        break
      }
    }
  }
  return {
    messages,
    oldestSequence,
    hasMore: turnStarts.length > selectedStarts.length,
    snapshotSequence: snapshotSeq,
  }
}

function sourceSequences(event: Record<string, unknown>): number[] {
  return Array.isArray(event.sourceEventSeqs)
    ? event.sourceEventSeqs.filter((value): value is number => Number.isSafeInteger(value))
    : []
}

function reasoningText(event: Record<string, unknown> | undefined): string[] {
  if (event?.type !== 'assistant/chunk' || !isRecord(event.data) || !isRecord(event.data.chunk)) return []
  const chunk = event.data.chunk
  return chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' ? [chunk.text] : []
}

function eventTimestamp(event: Record<string, unknown>): string {
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
  return new Date(time).toISOString()
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.text === 'string') return message.text
  if (!Array.isArray(message.content)) return ''
  return message.content.flatMap(block => {
    if (!isRecord(block)) return []
    if ((block.type === 'text' || block.type === 'input-text' || block.type === 'output-text') && typeof block.text === 'string') return [block.text]
    return []
  }).join('')
}

export function endReasonFromNotifications(notifications: unknown[]): RunEndReason {
  for (let index = notifications.length - 1; index >= 0; index--) {
    const item = notifications[index]
    if (!isRecord(item) || item.method !== 'session.event' || !isRecord(item.params)
      || !isRecord(item.params.event)) continue
    const event = item.params.event
    if (event.type !== 'turn/end' || !isRecord(event.data) || !isRecord(event.data.reason)) continue
    switch (event.data.reason.kind) {
      case 'completed': return 'completed'
      case 'aborted':
      case 'interrupted':
      case 'disposed': return 'cancelled'
      case 'max-tokens': return 'max_tokens'
      case 'error': return 'protocol_error'
      default: return 'protocol_error'
    }
  }
  // A resolved notification list without a terminal turn/end is not a
  // successful empty answer. Treat it as a protocol failure so the desktop
  // can surface the missing terminal event instead of silently closing the
  // run with no assistant message.
  return 'protocol_error'
}

/**
 * Preserve the provider failure attached to a completed Harness turn.
 *
 * pi-ai reports the failure twice in the persisted notification stream: the
 * assistant finish chunk carries `reason.failure`, while the authoritative
 * `turn/end` event carries `reason.error`. The latter is preferred because it
 * is the terminal turn result, but the former keeps this adapter useful when a
 * caller receives a truncated notification list.
 */
export function failureFromNotifications(notifications: readonly unknown[]): RunFailure | undefined {
  for (let index = notifications.length - 1; index >= 0; index--) {
    const event = sessionEvent(notifications[index])
    if (event === undefined) continue

    if (event.type === 'turn/end' && isRecord(event.data) && isRecord(event.data.reason)
      && event.data.reason.kind === 'error') {
      return normalizeFailure(event.data.reason.error, 'DeepSeek Harness turn failed')
    }

    if (event.type === 'assistant/chunk' && isRecord(event.data) && isRecord(event.data.chunk)
      && event.data.chunk.type === 'finish' && isRecord(event.data.chunk.reason)
      && event.data.chunk.reason.kind === 'error') {
      return normalizeFailure(event.data.chunk.reason.failure, 'DeepSeek Harness model request failed')
    }
  }
  return undefined
}

function sessionEvent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || value.method !== 'session.event' || !isRecord(value.params)
    || !isRecord(value.params.event)) return undefined
  return value.params.event
}

function normalizeFailure(value: unknown, fallback: string): RunFailure {
  if (!isRecord(value)) return { message: fallback, code: 'HARNESS_TURN_FAILED' }
  const message = typeof value.message === 'string' && value.message.trim() !== ''
    ? value.message.trim()
    : fallback
  const code = typeof value.code === 'string' && value.code.trim() !== ''
    ? value.code.trim()
    : undefined
  return code === undefined ? { message } : { message, code }
}

function adaptStreamChunk(value: unknown, options: HarnessNotificationAdaptOptions = {}): HostEvent[] {
  if (!isRecord(value)) return []
  if (value.type === 'text-delta' && typeof value.text === 'string') {
    return [{ type: 'assistant.delta', text: value.text }]
  }
  if (value.type === 'reasoning-delta' && typeof value.text === 'string') {
    return [{ type: 'reasoning.delta', text: value.text }]
  }
  if (value.type === 'usage') return options.includeUsage === false ? [] : adaptUsage(value.usage)
  return []
}

function adaptUsage(value: unknown, modelId?: string): HostEvent[] {
  if (!isRecord(value) || !numberValue(value.inputTokens) || !numberValue(value.outputTokens)) return []
  return [{
    type: 'usage',
    inputTokens: Number(value.inputTokens),
    outputTokens: Number(value.outputTokens),
    ...(modelId === undefined ? {} : { modelId }),
    ...optionalNumber('cacheReadTokens', value.cacheReadTokens),
    ...optionalNumber('cacheWriteTokens', value.cacheWriteTokens),
    ...optionalNumber('reasoningTokens', value.reasoningTokens),
  }]
}

function modelIdFromMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.source)) return undefined
  return stringValue(value.source.model)
}

function optionalNumber<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  return numberValue(value) ? { [key]: Number(value) } as Record<K, number> : {}
}

function numberValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function parseJsonOrString(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) as unknown } catch { return value }
}

function toolName(source: unknown): string {
  if (!isRecord(source)) return 'tool'
  // ToolResultSource uses `toolName` as its canonical field. Keep the
  // fallback spellings for older/session-generated records, but never turn a
  // successful result into the generic `tool` name when the real name exists.
  return stringValue(source.toolName)
    ?? stringValue(source.name)
    ?? stringValue(source.tool)
    ?? 'tool'
}

function contentResult(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? null
  if (value.length === 1 && isRecord(value[0]) && value[0].type === 'text') return value[0].text ?? ''
  return value
}
