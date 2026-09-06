import { requiredString } from '../protocol/json-rpc.js'

export function turnMethods(adapter) {
  return {
    'turn/start': async p => ({ turn: await adapter.startTurn(requiredString(p.threadId, 'threadId'), p.input ?? null) }),
    // Inject user input into the active turn's next-step inbox. This is the
    // DSH-native steering path; unlike turn/start it must not create a new
    // turn or wake a second driver.
    'turn/steer': async p => ({ accepted: await adapter.steerTurn(requiredString(p.threadId, 'threadId'), p.input ?? null, p.clientMessageId) }),
    'turn/interrupt': async p => adapter.interruptTurn(requiredString(p.threadId, 'threadId')),
  }
}
