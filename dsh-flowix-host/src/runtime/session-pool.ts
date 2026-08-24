import { DeepSeekHarness, type SessionUsageResult } from '@deepseek-ai/dsh-sdk-client'
import { FlowixDshBridgeClient } from '../bridge/client.ts'
import {
  adaptFlowixBridgeEvent,
  endReasonFromNotifications,
  failureFromNotifications,
  materializeSessionHistory,
} from '../adapter/session-events.ts'
import type { HostEvent, RunEventNotification, RunStartParams, RuntimeSpec, SessionHistoryPage } from '../protocol/v1.ts'
import { isRecord } from '../protocol/validation.ts'
import { HOST_PROTOCOL_VERSION } from '../protocol/v1.ts'
import { runtimeLaunch } from './environment.ts'
import { sessionPoolOptions } from './pool-options.ts'

type ResolvedRuntimeSpec = RuntimeSpec & { sessionId: string }

interface RuntimeSlot {
  spec: ResolvedRuntimeSpec
  harness: DeepSeekHarness
  bridge: FlowixDshBridgeClient
  /** A runtime transport can die without the host process dying. */
  reusable: boolean
  generation: number
  sequence: number
  lastUsedAt: number
  idleTimer: NodeJS.Timeout | undefined
  currentRun: { runId: string; cancelled: boolean } | undefined
  bridgeAvailable: boolean | undefined
}

export type EventSink = (event: RunEventNotification) => void

export class SessionPool {
  private readonly slots = new Map<string, RuntimeSlot>()

  constructor(
    private readonly emit: EventSink,
    private readonly options = sessionPoolOptions(),
  ) {}

  async ensure(spec: RuntimeSpec): Promise<{ sessionId: string; generation: number }> {
    const existing = this.slots.get(spec.threadId)
    // `DeepSeekHarness` intentionally keeps the runtime process alive after a
    // completed turn.  There is no public `isRuntimeRunning` property on the
    // SDK object; checking that nonexistent property made every completed slot
    // look dead (`undefined`), so the second message closed the live runtime
    // and recreated the same session id from scratch.  `reusable` is the pool's
    // authoritative transport-health bit: execute() clears it when the
    // runtime actually fails.
    if (existing !== undefined && existing.reusable && sameSpec(existing.spec, spec)) {
      this.clearIdleTimer(existing)
      return { sessionId: existing.spec.sessionId, generation: existing.generation }
    }
    const generation = (existing?.generation ?? 0) + 1
    if (existing !== undefined) await this.closeSlot(existing)
    const launch = runtimeLaunch(spec)
    const harness = new DeepSeekHarness({
      launch: {
        command: launch.command,
        args: launch.args,
        cwd: spec.cwd,
        env: launch.env,
        requestTimeoutMs: 120_000,
        shutdownTimeoutMs: 1_500,
      },
      cwd: spec.cwd,
      workspacePaths: spec.workspacePaths,
      provider: spec.provider,
      model: spec.model,
      ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
    })
    const bridge = new FlowixDshBridgeClient(harness)
    // This is the same minting path used by the official SDK. Flowix only
    // supplies an id when resuming a previously mapped Harness session.
    const sessionId = spec.sessionId ?? harness.session().id
    const resolvedSpec: ResolvedRuntimeSpec = { ...spec, sessionId }
    this.slots.set(spec.threadId, {
      spec: resolvedSpec,
      harness,
      bridge,
      reusable: true,
      generation,
      sequence: 0,
      lastUsedAt: Date.now(),
      idleTimer: undefined,
      currentRun: undefined,
      bridgeAvailable: undefined,
    })
    return { sessionId, generation }
  }

  startRun(params: RunStartParams): void {
    const slot = this.slots.get(params.threadId)
    if (slot === undefined) throw new Error(`runtime is not initialized for thread ${params.threadId}`)
    if (slot.currentRun !== undefined) throw new Error(`a run is already active for thread ${params.threadId}`)
    this.clearIdleTimer(slot)
    const marker = { runId: params.runId, cancelled: false }
    slot.currentRun = marker
    this.push(slot, params.runId, { type: 'session.resolved', sessionId: slot.spec.sessionId })
    this.push(slot, params.runId, { type: 'run.started' })
    void this.execute(slot, marker, params.prompt)
  }

  async cancel(threadId: string, runId: string): Promise<boolean> {
    const slot = this.slots.get(threadId)
    if (slot?.currentRun?.runId !== runId) return false
    slot.currentRun.cancelled = true
    this.clearIdleTimer(slot)
    if (slot.bridgeAvailable === true) {
      try {
        await slot.bridge.cancel(slot.spec.sessionId)
      } catch {
        // Closing the runtime remains the final cancellation boundary if the
        // bridge is already unavailable or the agent rejects cancellation.
      }
    }
    await slot.harness.close()
    this.push(slot, runId, { type: 'run.completed', reason: 'cancelled' })
    slot.currentRun = undefined
    this.slots.delete(threadId)
    return true
  }

  async dispose(threadId: string): Promise<boolean> {
    const slot = this.slots.get(threadId)
    if (slot === undefined) return false
    if (slot.currentRun !== undefined) slot.currentRun.cancelled = true
    await this.closeSlot(slot)
    return true
  }

  async close(): Promise<void> {
    const slots = [...this.slots.values()]
    this.slots.clear()
    for (const slot of slots) this.clearIdleTimer(slot)
    await Promise.allSettled(slots.map(async slot => await slot.harness.close()))
  }

  status(): Array<{ threadId: string; sessionId: string; generation: number; runId?: string }> {
    return [...this.slots.entries()].map(([threadId, slot]) => ({
      threadId,
      sessionId: slot.spec.sessionId,
      generation: slot.generation,
      ...(slot.currentRun === undefined ? {} : { runId: slot.currentRun.runId }),
    }))
  }

  async usage(sessionId: string): Promise<SessionUsageResult | undefined> {
    const slot = [...this.slots.values()].find(candidate => candidate.spec.sessionId === sessionId)
    if (slot === undefined) return undefined
    slot.lastUsedAt = Date.now()
    this.clearIdleTimer(slot)
    return await readSessionUsage(slot)
  }

  async history(
    sessionId: string,
    beforeSequence: number | undefined,
    limit: number,
    requestedSnapshot: number | undefined,
  ): Promise<SessionHistoryPage> {
    const spec = historyRuntimeSpec(sessionId)
    const launch = runtimeLaunch(spec)
    const harness = new DeepSeekHarness({
      launch: {
        command: launch.command,
        args: launch.args,
        cwd: spec.cwd,
        env: launch.env,
        requestTimeoutMs: 120_000,
        shutdownTimeoutMs: 1_500,
      },
      cwd: spec.cwd,
      workspacePaths: [],
      provider: spec.provider,
      model: spec.model,
    })
    const bridge = new FlowixDshBridgeClient(harness)
    const client = harness.client as unknown as { start(): void }
    client.start()
    try {
      const snapshot = await bridge.history(sessionId)
      const snapshotSeq = requestedSnapshot === undefined
        ? snapshot.snapshotSeq
        : Math.min(requestedSnapshot, snapshot.snapshotSeq)
      return materializeSessionHistory(snapshot.events, beforeSequence, limit, snapshotSeq)
    } finally {
      await harness.close()
    }
  }

  async bridgeCapabilities(threadId: string): Promise<unknown> {
    const slot = this.slots.get(threadId)
    if (slot === undefined) throw new Error(`runtime is not initialized for thread ${threadId}`)
    return slot.bridge.capabilities()
  }

  async bridgeStatus(threadId: string): Promise<unknown> {
    const slot = this.slots.get(threadId)
    if (slot === undefined) throw new Error(`runtime is not initialized for thread ${threadId}`)
    return slot.bridge.status()
  }


  private async execute(
    slot: RuntimeSlot,
    marker: { runId: string; cancelled: boolean },
    prompt: { modelText: string; displayText: string; clientMessageId: string },
  ): Promise<void> {
    try {
      await initializeRuntime(slot)
      slot.bridgeAvailable = await bridgeIsAvailable(slot.bridge)
      if (!slot.bridgeAvailable) throw new Error('flowix-dsh-bridge is required by the DSH runtime profile')
      await this.executeThroughBridge(slot, marker, prompt)
    } catch (error) {
      // Initialization and capability negotiation happen before either run
      // path owns its cleanup. Surface those failures using the same host
      // contract, then discard the dead runtime.
      if (!marker.cancelled) {
        slot.reusable = false
        this.push(slot, marker.runId, { type: 'run.error', message: errorMessage(error), code: 'HARNESS_RUN_FAILED' })
        this.push(slot, marker.runId, { type: 'run.completed', reason: 'runtime_crashed' })
      }
      if (slot.currentRun === marker) {
        slot.currentRun = undefined
        await this.closeSlot(slot)
      }
    }
  }

  private async executeThroughBridge(
    slot: RuntimeSlot,
    marker: { runId: string; cancelled: boolean },
    prompt: { modelText: string; displayText: string; clientMessageId: string },
  ): Promise<void> {
    let streamedUsage: Extract<HostEvent, { type: 'usage' }> | undefined
    const seenSessionEvents = new Set<string>()
    const notifications: unknown[] = []

    const eventKey = (event: Record<string, unknown>): string | undefined => {
      const sequence = event.seq
      if (typeof sequence === 'number' || typeof sequence === 'string') return `seq:${String(sequence)}`
      try {
        return `json:${JSON.stringify(event)}`
      } catch {
        return undefined
      }
    }

    const emitAdapted = (events: HostEvent[], key?: string): void => {
      if (key !== undefined) {
        if (seenSessionEvents.has(key)) return
        seenSessionEvents.add(key)
      }
      for (const event of events) {
        if (event.type === 'usage') {
          streamedUsage = event
          continue
        }
        this.push(slot, marker.runId, event)
      }
    }

    // flowix-dsh-bridge emits the DSH-native event stream independently of
    // the SDK server's compatibility notification. Subscribe before prompt
    // delivery so the bridge path is live for the complete turn. The legacy
    // onNotification path below remains active and is deduplicated by the
    // native session event sequence for old profiles and test runtimes.
    const bridgeSubscription = slot.bridge.subscribeEvents()
    try {
      await slot.bridge.ensureSession(slot.spec.sessionId)
      const { messageId } = await slot.bridge.prompt(slot.spec.sessionId, prompt)
      let received = false
      while (true) {
        const event = await bridgeSubscription.next()
        if (event.sessionId !== slot.spec.sessionId) continue
        if (event.kind === 'session.event') {
          const raw = isRecord(event.event) ? event.event : undefined
          if (!received && !isInboxReceipt(raw, messageId)) continue
          if (raw !== undefined) {
            received = true
            notifications.push({ method: 'session.event', params: { sessionId: event.sessionId, event: raw } })
            const key = eventKey(raw)
            emitAdapted(adaptFlowixBridgeEvent(event, { includeUsage: true }), key)
          }
          continue
        }
        if (received && event.kind === 'agent.status' && event.status === 'idle') break
      }
      if (!marker.cancelled) {
        await this.finishRun(slot, marker, notifications, streamedUsage)
      }
    } catch (error) {
      if (!marker.cancelled) {
        // HarnessClient permanently marks a dead transport unusable. Do not
        // retain this slot as idle: the next conversation must construct a
        // fresh client and reuse the persisted session id instead.
        slot.reusable = false
        this.push(slot, marker.runId, { type: 'run.error', message: errorMessage(error), code: 'HARNESS_RUN_FAILED' })
        this.push(slot, marker.runId, { type: 'run.completed', reason: 'runtime_crashed' })
      }
    } finally {
      bridgeSubscription.close()
      if (slot.currentRun === marker) {
        slot.currentRun = undefined
        if (slot.reusable) await this.retainIdle(slot)
        else await this.closeSlot(slot)
      }
    }
  }

  private async finishRun(
    slot: RuntimeSlot,
    marker: { runId: string; cancelled: boolean },
    notifications: unknown[],
    streamedUsage: Extract<HostEvent, { type: 'usage' }> | undefined,
  ): Promise<void> {
    const usage = await readSessionUsage(slot)
    if (usage !== undefined) {
      this.push(slot, marker.runId, {
        type: 'usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.modelId === undefined ? {} : { modelId: usage.modelId }),
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        ...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
        ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
      })
    } else if (streamedUsage !== undefined) {
      this.push(slot, marker.runId, streamedUsage)
    }
    const reason = endReasonFromNotifications(notifications)
    const failure = failureFromNotifications(notifications)
    if (failure !== undefined || reason === 'protocol_error') {
      this.push(slot, marker.runId, {
        type: 'run.error',
        message: failure?.message ?? 'DeepSeek Harness turn ended with a protocol error',
        ...(failure === undefined ? { code: 'PROTOCOL_ERROR' } : failure.code === undefined ? {} : { code: failure.code }),
      })
    }
    this.push(slot, marker.runId, { type: 'run.completed', reason })
  }

  private async retainIdle(slot: RuntimeSlot): Promise<void> {
    if (this.slots.get(slot.spec.threadId) !== slot) return
    slot.lastUsedAt = Date.now()
    this.clearIdleTimer(slot)
    if (this.options.idleTtlMs === 0) {
      await this.closeSlot(slot)
      return
    }
    slot.idleTimer = setTimeout(() => {
      if (slot.currentRun === undefined) void this.closeSlot(slot)
    }, this.options.idleTtlMs)
    slot.idleTimer.unref()

    const idle = [...this.slots.values()]
      .filter(candidate => candidate.currentRun === undefined)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    const excess = idle.length - this.options.maxIdleRuntimes
    if (excess > 0) {
      await Promise.allSettled(idle.slice(0, excess).map(async candidate => await this.closeSlot(candidate)))
    }
  }

  private async closeSlot(slot: RuntimeSlot): Promise<void> {
    if (this.slots.get(slot.spec.threadId) === slot) this.slots.delete(slot.spec.threadId)
    this.clearIdleTimer(slot)
    if (slot.bridgeAvailable === true) {
      try {
        await slot.bridge.disposeSession(slot.spec.sessionId)
      } catch {
        // Runtime teardown below is authoritative when the bridge has already
        // gone away or the session was disposed by DSH itself.
      }
    }
    await slot.harness.close()
  }

  private clearIdleTimer(slot: RuntimeSlot): void {
    if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer)
    slot.idleTimer = undefined
  }

  private push(slot: RuntimeSlot, runId: string, event: HostEvent): void {
    slot.sequence += 1
    this.emit({
      protocolVersion: HOST_PROTOCOL_VERSION,
      threadId: slot.spec.threadId,
      runId,
      sequence: slot.sequence,
      generation: slot.generation,
      event,
    })
  }
}

function historyRuntimeSpec(sessionId: string): RuntimeSpec {
  return {
    threadId: `history:${sessionId}`,
    sessionId,
    cwd: process.cwd(),
    workspacePaths: [],
    provider: 'history-only',
    providerName: 'History Only',
    apiProtocol: 'openai-completions',
    apiKeyEnv: 'DSH_API_KEY',
    baseUrl: 'http://127.0.0.1',
    model: 'history-only',
    agentPreset: 'minimal',
    permissionMode: 'read-only',
  }
}

async function readSessionUsage(slot: RuntimeSlot): Promise<SessionUsageResult | undefined> {
  try {
    return await slot.harness.session(slot.spec.sessionId).usage()
  } catch {
    // Usage is supplementary metadata. A completed answer must still reach
    // the UI when an older/custom runtime does not implement session/usage.
    return undefined
  }
}

async function bridgeIsAvailable(bridge: FlowixDshBridgeClient): Promise<boolean> {
  try {
    const result = await bridge.capabilities()
    return result.capabilities.includes('runtime-events')
      && result.capabilities.includes('session-control')
  } catch (error) {
    const message = errorMessage(error)
    if (/flowix-dsh-bridge plugin is not mounted|unknown .*flowix\.bridge|method not found.*flowix\.bridge/i.test(message)) {
      return false
    }
    throw error
  }
}

function isInboxReceipt(event: unknown, messageId: string): boolean {
  return isRecord(event)
    && event.type === 'agent/inbox/spliced'
    && isRecord(event.data)
    && Array.isArray(event.data.inserted)
    && event.data.inserted.some(message => isRecord(message) && message.id === messageId)
}

function sameSpec(left: RuntimeSpec, right: RuntimeSpec): boolean {
  return left.threadId === right.threadId
    && (left.sessionId === undefined || right.sessionId === undefined || left.sessionId === right.sessionId)
    && left.cwd === right.cwd
    && sameStrings(left.workspacePaths, right.workspacePaths)
    && left.provider === right.provider
    && left.providerName === right.providerName
    && left.apiProtocol === right.apiProtocol
    && left.apiKeyEnv === right.apiKeyEnv
    && left.baseUrl === right.baseUrl
    && left.model === right.model
    && left.maxTokens === right.maxTokens
    && left.agentPreset === right.agentPreset
    && left.permissionMode === right.permissionMode
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function errorMessage(error: unknown): string {
  const message = rawErrorMessage(error)
  const route = noAdapterRoute(message)
  if (route !== undefined) {
    return `DeepSeek Harness provider route "${route}" is unavailable in the local llm-pi-ai runtime; open Models and reconfigure it`
  }
  return message
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function noAdapterRoute(message: string): string | undefined {
  // Provider labels may contain spaces (for example, a user-created route
  // label). Prefer the quoted adapter id emitted by llm-pi-ai, then keep a
  // conservative fallback for older runtimes that omitted the quotes.
  return (/no adapter registered for provider\s+["']([^"']+)["']/iu.exec(message)?.[1]
    ?? /no adapter registered for provider\s+([^\s]+)/iu.exec(message)?.[1])
}

/**
 * Settings-file publishes its initial document asynchronously. SEA startup
 * can reach the SDK initialize handshake before llm-pi-ai has registered the
 * configured route, while a dev runtime usually happens to be slower. Retry
 * only that explicit readiness race; a genuinely unknown route still fails
 * promptly with the actionable configuration error below.
 */
async function initializeRuntime(slot: RuntimeSlot): Promise<void> {
  const attempts = 40
  for (let attempt = 0; ; attempt += 1) {
    try {
      await slot.bridge.initialize({
        cwd: slot.spec.cwd,
        provider: slot.spec.provider,
        model: slot.spec.model,
        ...(slot.spec.maxTokens === undefined ? {} : { maxTokens: slot.spec.maxTokens }),
      })
      return
    } catch (error) {
      if (noAdapterRoute(rawErrorMessage(error)) === undefined || attempt >= attempts - 1) throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}
