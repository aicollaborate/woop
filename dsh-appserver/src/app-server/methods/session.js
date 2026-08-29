import { requiredString } from '../protocol/json-rpc.js'

export function sessionMethods(adapter) {
  const id = p => requiredString(p.sessionId || p.threadId, 'sessionId')
  return {
    'session/flush': p => adapter.flush(requiredString(p.threadId || p.sessionId, 'threadId')),
    'session/ensure': p => adapter.ensureSession(id(p)),
    'session/prompt': async p => ({ turn: await adapter.startTurn(id(p), p.modelText ?? p.input) }),
    'session/history': p => adapter.sessionHistory(id(p)),
    'session/dispose': async p => ({ disposed: (await adapter.closeThread(id(p))).closed }),
    'run/cancel': async p => ({ cancelled: (await adapter.interruptTurn(id(p))).interrupted }),
    'flowix.bridge.session.ensure': p => adapter.ensureSession(id(p)),
    'flowix.bridge.session.prompt': p => adapter.startTurn(id(p), p.modelText ?? p.input),
    'flowix.bridge.session.history': p => adapter.sessionHistory(id(p)),
    'flowix.bridge.session.dispose': async p => ({ disposed: (await adapter.closeThread(id(p))).closed }),
    'flowix.bridge.run.cancel': async p => ({ cancelled: (await adapter.interruptTurn(id(p))).interrupted }),
  }
}
