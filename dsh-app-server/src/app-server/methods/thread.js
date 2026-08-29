import { requiredString } from '../protocol/json-rpc.js'

export function threadMethods(adapter, notify) {
  return {
    'thread/start': async p => {
      const thread = await adapter.startThread(typeof p.threadId === 'string' ? p.threadId : `thread-${Date.now()}`)
      notify('thread/started', { thread })
      return { thread }
    },
    'thread/resume': async p => {
      const thread = await adapter.resumeThread(requiredString(p.threadId, 'threadId'))
      notify('thread/resumed', { thread })
      return { thread }
    },
    'thread/read': async p => ({ thread: await adapter.readThread(requiredString(p.threadId, 'threadId'), p.includeTurns !== false) }),
    'thread/list': async () => ({ threads: await adapter.listThreads() }),
    'thread/fork': async p => {
      const thread = await adapter.forkThread(requiredString(p.threadId, 'threadId'), p.boundarySeq, p.newThreadId)
      notify('thread/started', { thread })
      return { thread }
    },
    'thread/turns/list': async p => ({ page: await adapter.listTurns(requiredString(p.threadId, 'threadId'), p.cursor, p.limit) }),
    'thread/events/list': async p => ({ page: await adapter.listEvents(requiredString(p.threadId, 'threadId'), p.afterSeq ?? -1, p.limit) }),
    'thread/close': async p => adapter.closeThread(requiredString(p.threadId, 'threadId')),
  }
}
