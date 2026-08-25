import type { CredentialReferenceParams, CredentialSetParams, JsonRpcRequest, ModelDiscoverParams, ModelSettingsWriteParams, RunStartParams, RuntimeSpec, SessionHistoryParams, SessionUsageParams } from './v1.ts'

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
  const sessionId = optionalString(params.sessionId)
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
    ...(sessionId === undefined ? {} : { sessionId }),
    cwd: requireString(params.cwd, 'cwd'),
    workspacePaths,
    provider: requireString(params.provider, 'provider'),
    providerName: requireString(params.providerName, 'providerName'),
    apiProtocol: apiProtocol as RuntimeSpec['apiProtocol'],
    apiKeyEnv: params.apiKeyEnv === undefined
      ? 'DSH_API_KEY'
      : requireCredentialRef(params.apiKeyEnv, 'apiKeyEnv'),
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

function requireCredentialRef(value: unknown, name: string): string {
  const ref = requireString(value, name)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    throw new ProtocolInputError(-32602, `${name} must be a valid credential reference`)
  }
  return ref
}

export function requireCredentialReference(value: unknown): CredentialReferenceParams {
  const params = requireRecord(value, 'credentials params')
  return { reference: requireCredentialRef(params.reference, 'reference') }
}

export function requireCredentialSet(value: unknown): CredentialSetParams {
  const params = requireRecord(value, 'credentials.set params')
  return {
    reference: requireCredentialRef(params.reference, 'reference'),
    value: requireString(params.value, 'value'),
  }
}

export function requireModelSettingsWrite(value: unknown, requireProfile: boolean): ModelSettingsWriteParams {
  const params = requireRecord(value, 'model settings params')
  const route = requireString(params.route, 'route')
  const expectedRevision = params.expectedRevision === undefined
    ? undefined
    : requireNonNegativeInteger(params.expectedRevision, 'expectedRevision')
  const profile = params.profile === undefined ? undefined : requireRecord(params.profile, 'profile')
  if (requireProfile && profile === undefined) throw new ProtocolInputError(-32602, 'profile is required')
  return { route, ...(profile === undefined ? {} : { profile }), ...(expectedRevision === undefined ? {} : { expectedRevision }) }
}

export function requireRunStart(value: unknown): RunStartParams {
  const params = requireRecord(value, 'run.start params')
  const prompt = requireRecord(params.prompt, 'prompt')
  return {
    threadId: requireString(params.threadId, 'threadId'),
    runId: requireString(params.runId, 'runId'),
    prompt: {
      modelText: requireString(prompt.modelText, 'prompt.modelText', true),
      displayText: requireString(prompt.displayText, 'prompt.displayText', true),
      clientMessageId: requireString(prompt.clientMessageId, 'prompt.clientMessageId'),
    },
  }
}

export function requireThreadRun(value: unknown): { threadId: string; runId: string } {
  const params = requireRecord(value, 'run params')
  return {
    threadId: requireString(params.threadId, 'threadId'),
    runId: requireString(params.runId, 'runId'),
  }
}

/** Optional string: absent or empty becomes `undefined`; never trims to a value. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value
}

/** Validate a `models.discover` draft. `discoverModels` re-checks the
 *  catalog/baseURL pair; here only wire-shape errors are rejected so the
 *  coded harness failures reach the caller intact. */
export function requireModelDiscover(value: unknown): ModelDiscoverParams {
  const params = requireRecord(value, 'models.discover params')
  if (params.api !== undefined && !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(params.api as string)) {
    throw new ProtocolInputError(-32602, `unsupported api: ${String(params.api)}`)
  }
  const result: ModelDiscoverParams = {}
  const provider = optionalString(params.provider)
  const baseUrl = optionalString(params.baseUrl)
  const api = params.api
  const apiKey = optionalString(params.apiKey)
  const apiKeyEnv = params.apiKeyEnv === undefined
    ? undefined
    : requireCredentialRef(params.apiKeyEnv, 'apiKeyEnv')
  if (provider !== undefined) result.provider = provider
  if (baseUrl !== undefined) result.baseUrl = baseUrl
  if (api !== undefined) {
    result.api = api as Exclude<ModelDiscoverParams['api'], undefined>
  }
  if (apiKey !== undefined) result.apiKey = apiKey
  if (apiKeyEnv !== undefined) result.apiKeyEnv = apiKeyEnv
  return result
}

/** Validate a `models.resolve` query for an exact route. */
export function requireModelResolve(value: unknown): { provider: string; model: string } {
  const params = requireRecord(value, 'models.resolve params')
  return {
    provider: requireString(params.provider, 'provider'),
    model: requireString(params.model, 'model'),
  }
}

export function requireThread(value: unknown): { threadId: string } {
  const params = requireRecord(value, 'runtime params')
  return { threadId: requireString(params.threadId, 'threadId') }
}

export function requireSessionUsage(value: unknown): SessionUsageParams {
  const params = requireRecord(value, 'session.usage params')
  return { sessionId: requireString(params.sessionId, 'sessionId') }
}

export function requireSessionHistory(value: unknown): SessionHistoryParams {
  const params = requireRecord(value, 'session.history params')
  const beforeSequence = params.beforeSequence
  if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || Number(beforeSequence) < 0)) {
    throw new ProtocolInputError(-32602, 'beforeSequence must be a non-negative integer')
  }
  const rawLimit = params.limit === undefined ? 50 : params.limit
  if (!Number.isSafeInteger(rawLimit) || Number(rawLimit) <= 0) {
    throw new ProtocolInputError(-32602, 'limit must be a positive integer')
  }
  return {
    sessionId: requireString(params.sessionId, 'sessionId'),
    ...(beforeSequence === undefined ? {} : { beforeSequence: Number(beforeSequence) }),
    ...(params.snapshotSequence === undefined ? {} : { snapshotSequence: requireNonNegativeInteger(params.snapshotSequence, 'snapshotSequence') }),
    limit: Math.min(Number(rawLimit), 50),
  }
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ProtocolInputError(-32602, `${name} must be a non-negative integer`)
  }
  return Number(value)
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
