/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SessionUsageParams,
  SessionUsageResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
}

/**
 * Settings-backed adapters can be registered just after the SDK transport is
 * ready. Give that initial settings publication a bounded chance to complete
 * before reporting a configured provider as missing.
 */
const ADAPTER_READY_TIMEOUT_MS = 2_000

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionModelIds = new Map<string, string>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const modelId = modelIdFromEvent(event)
      if (modelId !== undefined) this.sessionModelIds.set(String(session.id), modelId)
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    this.cwd = resolve(params.cwd)
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    if (!this.hasAdapterFor(this.provider)) {
      if (this.provider !== 'deepseek-official') {
        await this.waitForAdapter(this.provider)
        if (!this.hasAdapterFor(this.provider)) {
          throw new Error(`no adapter registered for provider "${this.provider}"`)
        }
      }
      if (this.provider === 'deepseek-official') {
        this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
      }
    }
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery (as the ACP bridge does).
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${params.sessionId}`)
    }
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Read the token-meter's whole-log usage projection for one live SDK
   * session. The projection has already replaced any early chunk sample with
   * the finalized sample for the same step, so this is safe to call once per
   * completed turn without client-side accumulation.
   */
  sessionUsage(params: SessionUsageParams): SessionUsageResult {
    const rec = this.sessions.get(params.sessionId)
    if (rec === undefined) throw new Error(`unknown SDK session: ${params.sessionId}`)
    const session = rec.handle.agent.session
    const projectionRegistry = this.ctx.get('sessionProjections') as SessionProjectionReader | undefined
    const projections = projectionRegistry?.snapshot(session).values
    const usage = tokenUsageOf(projections?.tokenUsage)
    const context = contextPressureOf(projections?.contextPressure)
    const modelId = this.sessionModelIds.get(params.sessionId) ?? latestModelId(session.events) ?? this.model
    return {
      sessionId: params.sessionId,
      modelId,
      inputTokens: usage?.uncachedInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      ...(context?.tokens === undefined ? {} : { contextTokens: context.tokens }),
      ...(context?.window === undefined ? {} : { contextWindow: context.window }),
    }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    this.sessionModelIds.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/usage':
        return this.sessionUsage(params as unknown as SessionUsageParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    const presets = this.ctx.get('agentPresets')
    const configuredPreset = process.env.DSH_AGENT_PRESET?.trim() || 'standard'
    const persistence = this.ctx.get('sessionPersistence')
    const stored = persistence === undefined
      || typeof persistence.list !== 'function'
      || typeof persistence.inspect !== 'function'
      ? undefined
      : (await persistence.list()).find((header: { id: string }) => header.id === sessionId)
    const agentPreset = stored === undefined
      ? configuredPreset
      : resolveSessionPreset({
        header: stored,
        events: (await persistence.inspect(SessionId(sessionId))).events,
      }) ?? configuredPreset
    const setup = async (agentCtx: Context): Promise<void> => {
      if (presets === undefined) {
        throw new Error('agent preset roster is not mounted')
      }
      await presets.mount(agentCtx, agentPreset)
    }
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
    }
    const handle = stored === undefined
      ? await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: this.cwd, agentPreset },
        setup,
        agentOptions,
      })
      : await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        setup,
        agentOptions,
      })
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }

  /**
   * Wait for a settings-driven adapter topology change during process boot.
   * The event is preferable to a fixed startup sleep, while the timeout keeps
   * a genuinely unknown provider fail-loud and bounded.
   */
  private waitForAdapter(provider: string): Promise<void> {
    if (this.hasAdapterFor(provider)) return Promise.resolve()
    if (this.ctx.get('llm') === undefined) return Promise.resolve()
    return new Promise(resolve => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        dispose()
        resolve()
      }
      const dispose = this.ctx.on('llm/adapters-updated', () => {
        if (this.hasAdapterFor(provider)) finish()
      })
      timer = setTimeout(finish, ADAPTER_READY_TIMEOUT_MS)
    })
  }
}

interface SessionProjectionReader {
  snapshot(session: Session): { values: Record<string, unknown> }
}

interface TokenUsageSnapshot {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface ContextPressureSnapshot {
  tokens?: number
  window?: number
}

function tokenUsageOf(value: unknown): TokenUsageSnapshot | undefined {
  if (!isRecord(value)
    || !nonNegativeNumber(value.uncachedInputTokens)
    || !nonNegativeNumber(value.outputTokens)
    || !nonNegativeNumber(value.cacheReadTokens)
    || !nonNegativeNumber(value.cacheWriteTokens)) return undefined
  return {
    uncachedInputTokens: value.uncachedInputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
  }
}

function contextPressureOf(value: unknown): ContextPressureSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const tokens = nonNegativeNumber(value.projectedTokens)
    ? value.projectedTokens
    : nonNegativeNumber(value.pressureTokens) ? value.pressureTokens : undefined
  const window = positiveNumber(value.contextWindow) ? value.contextWindow : undefined
  if (tokens === undefined && window === undefined) return undefined
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(window === undefined ? {} : { window }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function latestModelId(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    const modelId = event === undefined ? undefined : modelIdFromEvent(event)
    if (modelId !== undefined) return modelId
  }
  return undefined
}

function modelIdFromEvent(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  const model = event.data.message.source.model
  return typeof model === 'string' && model.length > 0 ? model : undefined
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
