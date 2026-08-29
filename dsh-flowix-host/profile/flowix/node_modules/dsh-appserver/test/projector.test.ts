import { describe, expect, it } from 'vitest'
// @ts-ignore production JavaScript module
import { assistantChunkText, projectNotifications, projectTurns } from '../src/app-server/adapters/event-projector.js'

describe('durable event projector', () => {
  it('rebuilds stable turns and items from DSH events', () => {
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', seq: 3, data: { id: 'a1', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 5, data: { turn: 2 } },
      { type: 'user/message', seq: 6, data: { id: 'u2', content: [{ type: 'text', text: 'stop' }] } },
      { type: 'turn/end', seq: 7, data: { turn: 2, reason: { kind: 'aborted' } } },
    ]
    const turns = projectTurns('thread-a', events)
    expect(turns.map((turn: { id: string }) => turn.id)).toEqual(['thread-a-turn-1', 'thread-a-turn-2'])
    expect(turns[0].items.map((item: { id: string }) => item.id)).toEqual(['thread-a-item-u1', 'thread-a-item-a1'])
    expect(turns[1].status).toBe('interrupted')
  })

  it('folds a durable approval audit pair into one completed item', () => {
    const turns = projectTurns('thread-a', [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'approval/asked', data: { id: 'approval-1', toolName: 'bash', callId: 'call-1', reason: 'elevated' } },
      { seq: 2, type: 'approval/decided', data: { id: 'approval-1', outcome: 'allowed-once' } },
      { seq: 3, type: 'turn/end', data: { turn: 1, reason: 'completed' } },
    ])
    expect(turns[0].items).toHaveLength(1)
    expect(turns[0].items[0]).toMatchObject({ id: 'thread-a-item-approval-1', type: 'approvalRequest', status: 'completed', toolName: 'bash', outcome: 'allowed-once' })
  })

  it('projects only text deltas from pi-ai assistant chunks', () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'internal thought' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'internal thought' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'hello' },
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const events = chunks.map((chunk, seq) => ({
      type: 'assistant/chunk', seq: seq + 1, data: { turn: 1, step: 1, chunk },
    }))

    expect(chunks.map(chunk => assistantChunkText({ chunk }))).toEqual([
      undefined, undefined, undefined, undefined, 'hello', undefined, undefined,
    ])
    expect(projectNotifications('thread-a', [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      ...events,
    ])).toEqual([
      expect.objectContaining({ method: 'turn/started' }),
      expect.objectContaining({
        method: 'item/agentMessage/delta',
        params: expect.objectContaining({ delta: 'hello' }),
      }),
    ])
  })
})
