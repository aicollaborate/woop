import { requiredString } from '../protocol/json-rpc.js'

export function approvalMethods(adapter) {
  return {
    'thread/approvalPolicy/read': async p => adapter.readApprovalPolicy(requiredString(p.threadId, 'threadId')),
    'thread/approvalPolicy/write': async p => adapter.writeApprovalPolicy(requiredString(p.threadId, 'threadId'), requiredString(p.policy, 'policy')),
  }
}
