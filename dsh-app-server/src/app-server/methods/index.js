import { credentialMethods } from './credential.js'
import { modelMethods } from './model.js'
import { runtimeMethods } from './runtime.js'
import { sessionMethods } from './session.js'
import { threadMethods } from './thread.js'
import { turnMethods } from './turn.js'
import { approvalMethods } from './approval.js'

export function createMethodRegistry(adapter, notify) {
  return new Map(Object.entries({
    ...threadMethods(adapter, notify),
    ...turnMethods(adapter),
    ...modelMethods(adapter),
    ...credentialMethods(adapter),
    ...runtimeMethods(adapter),
    ...sessionMethods(adapter),
    ...approvalMethods(adapter),
  }))
}
