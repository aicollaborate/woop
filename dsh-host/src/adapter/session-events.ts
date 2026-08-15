import type { HostEvent, RunEndReason } from '../protocol/v1.ts'
import { isRecord } from '../protocol/validation.ts'

export function adaptHarnessNotification(notification: unknown): HostEvent[] {
  if (!isRecord(notification) || notification.method !== 'session.event') return []
  const params = notification.params
  if (!isRecord(params) || !isRecord(params.event)) return []
  return adaptSessionEvent(params.event)
}

export function adaptSessionEvent(event: Record<string, unknown>): HostEvent[] {
  const data = event.data
  if (!isRecord(data)) return []
  switch (event.type) {
    case 'assistant/chunk':
      return adaptStreamChunk(data.chunk)
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
      return adaptUsage(data.usage)
    default:
      return []
  }
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
  return 'completed'
}

function adaptStreamChunk(value: unknown): HostEvent[] {
  if (!isRecord(value)) return []
  if (value.type === 'text-delta' && typeof value.text === 'string') {
    return [{ type: 'assistant.delta', text: value.text }]
  }
  if (value.type === 'reasoning-delta' && typeof value.text === 'string') {
    return [{ type: 'reasoning.delta', text: value.text }]
  }
  if (value.type === 'usage') return adaptUsage(value.usage)
  return []
}

function adaptUsage(value: unknown): HostEvent[] {
  if (!isRecord(value) || !numberValue(value.inputTokens) || !numberValue(value.outputTokens)) return []
  return [{
    type: 'usage',
    inputTokens: Number(value.inputTokens),
    outputTokens: Number(value.outputTokens),
    ...optionalNumber('cacheReadTokens', value.cacheReadTokens),
    ...optionalNumber('cacheWriteTokens', value.cacheWriteTokens),
    ...optionalNumber('reasoningTokens', value.reasoningTokens),
  }]
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
  return stringValue(source.name) ?? stringValue(source.tool) ?? 'tool'
}

function contentResult(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? null
  if (value.length === 1 && isRecord(value[0]) && value[0].type === 'text') return value[0].text ?? ''
  return value
}

