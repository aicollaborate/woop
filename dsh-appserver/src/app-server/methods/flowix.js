import { requiredString } from '../protocol/json-rpc.js'

/** Flowix-owned extensions which are intentionally outside the generic
 * Thread/Turn App Server surface. Keeping these under flowix/* lets Desktop
 * keep Flowix-owned extensions separate from the generic App Server surface
 * to product-specific UI concerns. */
export function flowixMethods(adapter) {
  return {
    'flowix/jobs/list': p => adapter.listJobs(requiredString(p.threadId, 'threadId')),
    'flowix/session/usage': p => adapter.sessionUsage(requiredString(p.sessionId || p.threadId, 'sessionId')),
    'flowix/plugins/list': () => adapter.listPlugins(),
    'flowix/runtime/profile': () => adapter.profileInfo(),
  }
}
