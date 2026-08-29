import { requiredString } from '../protocol/json-rpc.js'

export function turnMethods(adapter) {
  return {
    'turn/start': async p => ({ turn: await adapter.startTurn(requiredString(p.threadId, 'threadId'), p.input ?? null) }),
    'turn/interrupt': async p => adapter.interruptTurn(requiredString(p.threadId, 'threadId')),
  }
}
