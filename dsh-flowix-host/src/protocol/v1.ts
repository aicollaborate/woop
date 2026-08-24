export const HOST_PROTOCOL_VERSION = 1 as const

export type JsonRpcId = number | string

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface RuntimeSpec {
  threadId: string
  /** Persisted Harness id; omitted on first use so the SDK can mint one. */
  sessionId?: string
  cwd: string
  /** All Flowix-selected workspace roots. `cwd` is always included by the host. */
  workspacePaths: string[]
  /** Native llm-pi-ai provider route, for example `deepseek` or `openai`. */
  provider: string
  /** Provider label from Flowix settings, used for diagnostics/UI metadata. */
  providerName: string
  /** Wire protocol used by the configured provider endpoint. */
  apiProtocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  /** DSH credentials reference used by the selected provider route. */
  apiKeyEnv: string
  /** Base URL for the configured provider endpoint. */
  baseUrl: string
  model: string
  maxTokens?: number
  /** DeepSeek Harness Agent preset / conversation mode. */
  agentPreset: 'standard' | 'code' | 'minimal' | 'cordis'
  permissionMode: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export interface RunStartParams {
  threadId: string
  runId: string
  prompt: { modelText: string; displayText: string; clientMessageId: string }
}

export interface RuntimeDisposeParams {
  threadId: string
}

export interface SessionUsageParams {
  sessionId: string
}

export interface SessionHistoryParams {
  sessionId: string
  beforeSequence?: number
  snapshotSequence?: number
  limit: number
}

export interface HistoryMessage {
  id: string
  role: 'user' | 'assistant' | 'reasoning' | 'tool'
  content: string
  timestamp: string
  isLoading?: boolean
  isCompleted?: boolean
  toolCallId?: string
  toolName?: string
  toolData?: string
  toolInput?: unknown
}

export interface SessionHistoryPage {
  messages: HistoryMessage[]
  oldestSequence: number | null
  hasMore: boolean
  snapshotSequence: number
}

export interface ThreadParams {
  threadId: string
}


/** One `models.discover` interrogation: the draft endpoint the user is editing. */
export interface ModelDiscoverParams {
  /** Route the draft edits, when it edits a catalog-known one. */
  provider?: string
  /** Endpoint to interrogate; required when no catalog route answers. */
  baseUrl?: string
  /** Wire protocol the draft names; defaults to OpenAI Chat Completions. */
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  /** One-shot probe credential; the host never stores it. */
  apiKey?: string
}

/** One `models.resolve` query for an exact provider/model route. */
export interface ModelResolveParams {
  provider: string
  model: string
}

export type HostEvent =
  | { type: 'runtime.started'; sessionId: string }
  | { type: 'runtime.stopped'; reason?: string }
  | { type: 'session.resolved'; sessionId: string }
  | { type: 'run.started' }
  | { type: 'assistant.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool.started'; id: string; name: string; input: unknown }
  | { type: 'tool.completed'; id: string; name: string; result: unknown; isError?: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; modelId?: string; cacheReadTokens?: number; cacheWriteTokens?: number; contextTokens?: number; contextWindow?: number; reasoningTokens?: number }
  | { type: 'run.completed'; reason: RunEndReason }
  | { type: 'run.error'; message: string; code?: string }

export type RunEndReason =
  | 'completed'
  | 'cancelled'
  | 'max_tokens'
  | 'runtime_crashed'
  | 'protocol_error'

export interface RunEventNotification {
  protocolVersion: typeof HOST_PROTOCOL_VERSION
  threadId: string
  runId: string
  sequence: number
  generation: number
  event: HostEvent
}
