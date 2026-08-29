function parseArguments(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return {}
  try { return JSON.parse(value) } catch { return { raw: value } }
}

export function presentApproval(request, toolCall) {
  const toolName = String(request.toolName || toolCall?.data?.name || 'tool')
  const args = parseArguments(toolCall?.data?.arguments)
  const common = {
    toolName,
    callId: request.callId,
    reason: request.reason,
  }

  if (/^(bash|shell|exec|command)/i.test(toolName)) {
    return {
      kind: 'commandExecution',
      method: 'item/commandExecution/requestApproval',
      details: {
        ...common,
        command: args.command ?? args.cmd ?? args.raw,
        cwd: args.cwd,
      },
    }
  }
  if (/(str_replace_editor|apply_patch|file|edit|write)/i.test(toolName)) {
    return {
      kind: 'fileChange',
      method: 'item/fileChange/requestApproval',
      details: {
        ...common,
        path: args.path ?? args.file_path ?? args.filePath,
        changes: args.changes ?? args.patch,
      },
    }
  }
  if (/(permission|sandbox)/i.test(toolName)) {
    return { kind: 'permissions', method: 'item/permissions/requestApproval', details: { ...common, request: args } }
  }
  return { kind: 'tool', method: 'item/tool/requestApproval', details: { ...common, arguments: args } }
}
