import type { JsonRpcRequest, RunStartParams, RuntimeSpec } from './v1.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== '2.0'
    || (typeof value.id !== 'string' && typeof value.id !== 'number')
    || typeof value.method !== 'string') {
    throw new ProtocolInputError(-32600, 'invalid JSON-RPC request')
  }
  return value as unknown as JsonRpcRequest
}

export function requireRuntimeSpec(value: unknown): RuntimeSpec {
  const params = requireRecord(value, 'runtime.ensure params')
  const workspacePaths = params.workspacePaths === undefined
    ? []
    : requireStringArray(params.workspacePaths, 'workspacePaths')
  const permissionMode = requireString(params.permissionMode, 'permissionMode')
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(permissionMode)) {
    throw new ProtocolInputError(-32602, `unsupported permissionMode: ${permissionMode}`)
  }
  const maxTokens = params.maxTokens
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || Number(maxTokens) <= 0)) {
    throw new ProtocolInputError(-32602, 'maxTokens must be a positive integer')
  }
  const apiProtocol = requireString(params.apiProtocol, 'apiProtocol')
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(apiProtocol)) {
    throw new ProtocolInputError(-32602, `unsupported apiProtocol: ${apiProtocol}`)
  }
  const agentPreset = params.agentPreset === undefined
    ? 'standard'
    : requireString(params.agentPreset, 'agentPreset')
  if (!['standard', 'code', 'minimal', 'cordis'].includes(agentPreset)) {
    throw new ProtocolInputError(-32602, `unsupported agentPreset: ${agentPreset}`)
  }
  return {
    threadId: requireString(params.threadId, 'threadId'),
    sessionId: requireString(params.sessionId, 'sessionId'),
    cwd: requireString(params.cwd, 'cwd'),
    workspacePaths,
    provider: requireString(params.provider, 'provider'),
    providerName: requireString(params.providerName, 'providerName'),
    apiProtocol: apiProtocol as RuntimeSpec['apiProtocol'],
    baseUrl: requireString(params.baseUrl, 'baseUrl'),
    model: requireString(params.model, 'model'),
    ...(maxTokens === undefined ? {} : { maxTokens: Number(maxTokens) }),
    agentPreset: agentPreset as RuntimeSpec['agentPreset'],
    permissionMode: permissionMode as RuntimeSpec['permissionMode'],
  }
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim() !== '')) {
    throw new ProtocolInputError(-32602, `${name} must be an array of non-empty strings`)
  }
  return [...new Set(value.map(item => (item as string).trim()))]
}

export function requireRunStart(value: unknown): RunStartParams {
  const params = requireRecord(value, 'run.start params')
  const prompt = requireRecord(params.prompt, 'prompt')
  return {
    threadId: requireString(params.threadId, 'threadId'),
    runId: requireString(params.runId, 'runId'),
    prompt: { text: requireString(prompt.text, 'prompt.text', true) },
  }
}

export function requireThreadRun(value: unknown): { threadId: string; runId: string } {
  const params = requireRecord(value, 'run params')
  return {
    threadId: requireString(params.threadId, 'threadId'),
    runId: requireString(params.runId, 'runId'),
  }
}

export function requireThread(value: unknown): { threadId: string } {
  const params = requireRecord(value, 'runtime params')
  return { threadId: requireString(params.threadId, 'threadId') }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolInputError(-32602, `${name} must be an object`)
  return value
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new ProtocolInputError(-32602, `${name} must be a non-empty string`)
  }
  return value
}

export class ProtocolInputError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'ProtocolInputError'
  }
}
