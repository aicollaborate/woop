import { describe, expect, it } from 'vitest'
// @ts-ignore production JavaScript module
import { assistantChunkText, itemFromEvent, messageFromEvent, projectHistoryMessages, projectNotifications, projectTurns, turnEndStatus } from '../src/app-server/adapters/event-projector.js'

describe('durable event projector', () => {
  it('ends a max-token round as failed so automatic continuation can stop', () => {
    expect(turnEndStatus({ reason: { kind: 'max-tokens' } })).toBe('failed')
    expect(turnEndStatus({ reason: 'max_tokens' })).toBe('failed')
  })

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

  it('adds compact checkpoints to thread/read without hiding transcript turns', () => {
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'old question' }] }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 3, data: { message: { id: 'a1', content: [{ type: 'text', text: 'old answer' }] } }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'command/run', seq: 5, data: { commandId: 'cmd-compact', name: 'compact', args: '', source: { kind: 'user' } } },
      {
        type: 'user/message', seq: 6,
        data: {
          id: 'checkpoint-1',
          content: [{ type: 'text', text: '<compacted-summary>internal summary</compacted-summary>' }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1', sourceCommandId: 'cmd-compact' },
        },
        surfaceOp: { op: 'replace', start: 1, end: 4 },
      },
      { type: 'command/done', seq: 7, data: { commandId: 'cmd-compact', kind: 'success', text: 'Compacted 2 history items (~12 tokens).' } },
    ]

    const turns = projectTurns('thread-a', events, [], { preserveCompactedHistory: true })
    expect(turns).toHaveLength(3)
    expect(turns[0].items).toEqual([
      expect.objectContaining({ id: 'thread-a-item-u1', type: 'userMessage', sourceSeq: 2 }),
      expect.objectContaining({ id: 'thread-a-item-3', type: 'agentMessage', sourceSeq: 3 }),
    ])
    expect(turns[1]).toMatchObject({
      id: 'thread-a-timeline-5',
      status: 'completed',
      items: [expect.objectContaining({
        id: 'dsh-command:cmd-compact:input',
        type: 'userMessage',
        messageType: 'dsh-command',
        text: '/compact',
        sourceSeq: 5,
      })],
    })
    expect(turns[2]).toMatchObject({
      id: 'thread-a-timeline-6',
      status: 'completed',
      items: [expect.objectContaining({
        id: 'checkpoint-1',
        type: 'systemMessage',
        messageType: 'context-compaction',
        text: 'Compacted 2 history items (~12 tokens).',
        sourceSeq: 6,
      })],
    })
  })

  it('does not expose injected runtime context through thread items', () => {
    expect(itemFromEvent('thread-a', {
      type: 'user/message', seq: 1,
      data: { content: [{ type: 'text', text: '<system-reminder>internal</system-reminder>' }] },
    })).toBeUndefined()
    expect(itemFromEvent('thread-a', {
      type: 'user/message', seq: 2,
      data: { content: [{ type: 'text', text: 'visible\n<## CONTEXT PROMPT ##>hidden' }] },
    })).toMatchObject({ type: 'userMessage', text: 'visible' })
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

  it('does not serialize assistant tool-call blocks into live assistant text', () => {
    const item = itemFromEvent('thread-a', {
      type: 'assistant/message',
      seq: 7,
      data: {
        message: {
          id: 'assistant-1',
          content: [
            { type: 'text', text: '好的，继续测试更多工具。' },
            { type: 'tool-call', id: 'call-1', name: 'grep', arguments: '{"pattern":"TODO"}' },
            { type: 'tool-call', id: 'call-2', name: 'read', arguments: '{"file_path":"README.md"}' },
          ],
        },
      },
    })

    expect(item).toMatchObject({
      type: 'agentMessage',
      text: '好的，继续测试更多工具。',
    })
    expect(item?.text).not.toContain('tool-call')
    expect(item?.text).not.toContain('call-1')
  })

  it('projects reasoning and folds a tool call/result pair into one readable row', () => {
    const messages = projectHistoryMessages('thread-a', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { id: 'u1', content: [{ type: 'text', text: 'inspect' }] } },
      {
        type: 'assistant/message', seq: 3, data: { message: { id: 'a1', content: [
          { type: 'reasoning', text: 'I will inspect the file.' },
          { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"a.txt"}' },
        ] } },
      },
      { type: 'tool/call', seq: 4, time: '2026-09-06T10:00:00.000Z', data: { callId: 'call-1', name: 'read', arguments: '{"file_path":"a.txt"}' } },
      {
        type: 'tool/result', seq: 5, time: '2026-09-06T10:00:02.000Z', data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [
          { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'alpha' }] },
        ] } },
      },
    ])

    expect(messages.map(message => message.role)).toEqual(['user', 'reasoning', 'assistant', 'tool'])
    expect(messages[1].content).toBe('I will inspect the file.')
    expect(messages[3]).toMatchObject({
      id: 'call-1', content: 'alpha', toolData: 'alpha',
      toolCallId: 'call-1', toolName: 'read', toolInput: { file_path: 'a.txt' },
      isCompleted: true, isLoading: false,
      toolCall: expect.objectContaining({ type: 'tool/call', time: '2026-09-06T10:00:00.000Z' }),
      toolResult: expect.objectContaining({ type: 'tool/result', time: '2026-09-06T10:00:02.000Z' }),
    })
    expect(messages[3].timestamp).toBe('2026-09-06T10:00:02.000Z')
    expect(new Set(messages.map(message => message.id)).size).toBe(messages.length)
  })

  it('replays durable goal changes as lifecycle notifications', () => {
    expect(projectNotifications('thread-a', [
      {
        type: 'goal/change', seq: 7,
        data: {
          kind: 'goal/change', version: 1, operation: 'complete',
          goal: { id: 'goal-1', revision: 2, objective: 'ship it', phase: 'complete', maxGoalRounds: 3 },
          roundsStarted: 2, createdAt: 1, updatedAt: 7,
        },
      },
    ])).toEqual([expect.objectContaining({
      method: 'goal/changed',
      params: expect.objectContaining({ threadId: 'thread-a', sourceSeq: 7 }),
    })])
  })

  it('keeps a tool call running when its result is not in history yet', () => {
    const [tool] = projectHistoryMessages('thread-a', [
      { type: 'tool/call', seq: 1, time: '2026-09-06T10:00:00.000Z', data: { callId: 'call-1', name: 'read', arguments: '{}' } },
    ])

    expect(tool).toMatchObject({ role: 'tool', isLoading: true, isCompleted: false })
    expect(tool.timestamp).toBe('2026-09-06T10:00:00.000Z')
  })

  it('honors DSH surface replacement and projects a compact checkpoint', () => {
    const messages = projectHistoryMessages('thread-a', [
      { type: 'user/message', seq: 1, data: { id: 'u1', content: [{ type: 'text', text: 'old question' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 2, data: { message: { id: 'a1', content: [{ type: 'text', text: 'old answer' }] } }, surfaceOp: 'append' },
      { type: 'tool/call', seq: 3, data: { callId: 'call-old', name: 'read', arguments: '{}' } },
      { type: 'tool/result', seq: 4, data: { callId: 'call-old', result: 'old tool result' }, surfaceOp: 'append' },
      {
        type: 'user/message', seq: 5,
        data: {
          id: 'checkpoint-1',
          content: [{ type: 'text', text: 'This is a checkpoint.\n\n<compacted-summary>\n## Current Work\n- keep this\n</compacted-summary>' }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1' },
        },
        surfaceOp: { op: 'replace', start: 1, end: 4 },
        sourceEventSeqs: [1, 2, 3, 4],
      },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'checkpoint-1',
      role: 'system',
      messageType: 'context-compaction',
      content: '',
      sourceSequence: 5,
    })
  })

  it('preserves the Flowix timeline and appends the compact checkpoint', () => {
    const messages = projectHistoryMessages('thread-a', [
      { type: 'user/message', seq: 1, data: { id: 'u1', content: [{ type: 'text', text: 'old question' }] }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 2, data: { message: { id: 'a1', content: [{ type: 'text', text: 'old answer' }] } }, surfaceOp: 'append' },
      {
        type: 'user/message', seq: 3,
        data: {
          id: 'checkpoint-1',
          content: [{ type: 'text', text: 'checkpoint\n\n<compacted-summary>\n## Current Work\n- keep this\n</compacted-summary>' }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1' },
        },
        surfaceOp: { op: 'replace', start: 1, end: 2 },
      },
    ], undefined, undefined, { preserveCompactedHistory: true })

    expect(messages.map(message => message.content)).toEqual(['old question', 'old answer', ''])
    expect(messages[2]).toMatchObject({
      id: 'checkpoint-1',
      role: 'system',
      messageType: 'context-compaction',
    })
  })

  it('projects the compact command and completion checkpoint, not the model summary', () => {
    const messages = projectHistoryMessages('thread-a', [
      { type: 'command/run', seq: 10, data: {
        commandId: 'cmd-compact', name: 'compact', args: '', source: { kind: 'user' },
      } },
      { type: 'compaction/start', seq: 11, data: {
        compactionId: 'compact-1', sourceCommandId: 'cmd-compact',
      } },
      { type: 'compaction/summary', seq: 12, data: {
        compactionId: 'compact-1', sourceCommandId: 'cmd-compact',
        summary: [{ type: 'text', text: 'internal model summary that must stay hidden' }],
      } },
      {
        type: 'user/message', seq: 13,
        data: {
          id: 'checkpoint-1',
          content: [{ type: 'text', text: '<compacted-summary>internal model summary that must stay hidden</compacted-summary>' }],
          source: {
            kind: 'plugin', plugin: 'compact', compactionId: 'compact-1',
            sourceCommandId: 'cmd-compact',
          },
        },
        surfaceOp: { op: 'replace', start: 1, end: 9 },
      },
      { type: 'compaction/end', seq: 14, data: {
        compactionId: 'compact-1', sourceCommandId: 'cmd-compact',
      } },
      { type: 'command/done', seq: 15, data: {
        commandId: 'cmd-compact', kind: 'success',
        text: 'Compacted 36 history items (~11479 tokens).',
      } },
    ])

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'dsh-command:cmd-compact:input',
        role: 'user',
        messageType: 'dsh-command',
        content: '/compact',
        sourceSequence: 10,
        isLoading: false,
        isCompleted: true,
      }),
      expect.objectContaining({
        id: 'checkpoint-1',
        role: 'system',
        messageType: 'context-compaction',
        content: 'Compacted 36 history items (~11479 tokens).',
      }),
    ])
  })

  it('projects DSH goal control messages as independent compact system messages', () => {
    const roundEvent = {
      type: 'user/message', seq: 8,
      data: {
        id: 'goal-round-1',
        content: [{ type: 'text', text: '<goal_round> Objective: "在吗" Round: 1/256\n\nContinue working...\n</goal_round>' }],
        source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 },
      },
      surfaceOp: 'append',
    }
    const round = messageFromEvent('thread-a', roundEvent)
    expect(round).toMatchObject({
      id: 'goal-round-1', role: 'system', messageType: 'goal-round',
      content: '目标执行中：在吗（第 1/256 轮）', sourceSequence: 8,
    })

    const completeEvent = {
      type: 'user/message', seq: 9,
      data: {
        id: 'goal-complete-1',
        content: [{ type: 'text', text: '<goal_complete>\nObjective: "在吗"\nThe goal is marked complete...\n</goal_complete>' }],
        source: { kind: 'plugin', plugin: 'tool-goal', form: 'notice', summary: 'complete: 在吗' },
      },
      surfaceOp: 'append',
    }
    expect(messageFromEvent('thread-a', completeEvent)).toMatchObject({
      role: 'system', messageType: 'goal-complete', content: '目标已完成：在吗',
    })
    expect(itemFromEvent('thread-a', roundEvent)).toMatchObject({
      type: 'userMessage', messageType: 'goal-round', text: '目标执行中：在吗（第 1/256 轮）',
    })
  })

  it('projects durable DSH command lifecycle rows', () => {
    const messages = projectHistoryMessages('thread-a', [
      { type: 'command/run', seq: 10, time: 100, data: {
        commandId: 'cmd-1', name: 'goal', args: ' 在吗', source: { kind: 'user' },
      } },
      { type: 'command/done', seq: 11, time: 101, data: {
        commandId: 'cmd-1', kind: 'success', text: 'Goal created',
      } },
    ])

    expect(messages).toMatchObject([
      {
        id: 'dsh-command:cmd-1:input', role: 'user', messageType: 'dsh-command',
        content: '/goal 在吗', sourceSequence: 10, isLoading: false,
      },
      {
        id: 'dsh-command:cmd-1:result', role: 'system', messageType: 'dsh-command-result',
        content: 'Goal created', sourceSequence: 11,
      },
    ])
  })

  it('does not duplicate the real user prompt steered by /plan', () => {
    const events = [
      { type: 'command/run', seq: 20, data: {
        commandId: 'cmd-plan', name: 'plan', args: ' inspect this', source: { kind: 'user' },
      } },
      { type: 'command/done', seq: 21, data: {
        commandId: 'cmd-plan', kind: 'success', text: 'Plan mode on.',
      } },
      { type: 'user/message', seq: 22, data: {
        id: 'steer-1', content: [{ type: 'text', text: 'inspect this' }], source: { kind: 'user' },
      } },
      { type: 'assistant/message', seq: 23, data: {
        message: { id: 'answer-1', content: [{ type: 'text', text: 'I will inspect it.' }] },
      } },
    ]
    const messages = projectHistoryMessages('thread-a', events)

    expect(messages.map(message => message.content)).toEqual([
      '/plan inspect this', 'Plan mode on.', 'I will inspect it.',
    ])
    expect(messages.find(message => message.id === 'dsh-command:cmd-plan:input')).toMatchObject({
      role: 'user', messageType: 'dsh-command', isLoading: false,
    })
    expect(messages.find(message => message.id === 'steer-1')).toBeUndefined()
    expect(projectNotifications('thread-a', events)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ params: expect.objectContaining({ sourceSeq: 22 }) }),
      ]),
    )
  })

  it('keeps only the /plan command row and hides plan-mode control messages', () => {
    const events = [
      { type: 'command/run', seq: 18, data: {
        commandId: 'cmd-plan', name: 'plan', args: ' 为我分析项目', source: { kind: 'user' },
      } },
      { type: 'command/done', seq: 24, data: {
        commandId: 'cmd-plan', kind: 'success', text: 'Plan mode on.',
      } },
      { type: 'user/message', seq: 26, data: {
        id: 'plan-notice',
        content: [{ type: 'text', text: 'The user switched this session to plan mode.' }],
        source: { kind: 'plugin', plugin: 'plan-mode', form: 'notice' },
      } },
      { type: 'user/message', seq: 27, data: {
        id: 'steer-1',
        content: [{ type: 'text', text: '为我分析项目' }],
        source: { kind: 'user' },
      } },
    ]

    const messages = projectHistoryMessages('thread-a', events)
    expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
      '/plan 为我分析项目',
    ])
    expect(messages.find(message => message.sourceSequence === 26)).toBeUndefined()
    expect(messages.find(message => message.sourceSequence === 27)).toBeUndefined()
  })

  it('uses command/done from the full snapshot when the command page contains only command/run', () => {
    const messages = projectHistoryMessages('thread-a', [
      { type: 'command/run', seq: 10, data: {
        commandId: 'cmd-cross-page', name: 'compact', args: '', source: { kind: 'user' },
      } },
    ], undefined, [
      { type: 'command/run', seq: 10, data: {
        commandId: 'cmd-cross-page', name: 'compact', args: '', source: { kind: 'user' },
      } },
      { type: 'command/done', seq: 11, data: {
        commandId: 'cmd-cross-page', kind: 'success', text: 'Compacted',
      } },
    ])

    expect(messages).toMatchObject([
      expect.objectContaining({
        id: 'dsh-command:cmd-cross-page:input',
        isLoading: false,
        isCompleted: true,
      }),
    ])
  })
})
