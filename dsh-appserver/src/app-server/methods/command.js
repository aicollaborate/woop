import { requiredString } from '../protocol/json-rpc.js'

/** DSH-owned human command and skill discovery bridge. */
export function commandMethods(adapter) {
  return {
    'thread/command': async p => adapter.executeCommand(
      requiredString(p.threadId, 'threadId'),
      requiredString(p.command, 'command'),
      Array.isArray(p.attachments) ? p.attachments : [],
    ),
    'thread/skills': async p => adapter.listSkills(requiredString(p.threadId, 'threadId')),
  }
}
