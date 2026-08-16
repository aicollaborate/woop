import { DeepSeekHarness, type SessionUsageResult } from '@deepseek-ai/dsh-sdk-client'
import {
  adaptHarnessNotification,
  endReasonFromNotifications,
  failureFromNotifications,
} from '../adapter/session-events.ts'
import type { HostEvent, RunEventNotification, RunStartParams, RuntimeSpec } from '../protocol/v1.ts'
import { HOST_PROTOCOL_VERSION } from '../protocol/v1.ts'
import { runtimeLaunch } from './environment.ts'
import { sessionPoolOptions } from './pool-options.ts'

interface RuntimeSlot {
  spec: RuntimeSpec
  harness: DeepSeekHarness
  generation: number
  sequence: number
  lastUsedAt: number
  idleTimer: NodeJS.Timeout | undefined
  currentRun: { runId: string; cancelled: boolean } | undefined
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
    if (existing !== undefined && sameSpec(existing.spec, spec)) {
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
    this.slots.set(spec.threadId, {
      spec,
      harness,
      generation,
      sequence: 0,
      lastUsedAt: Date.now(),
      idleTimer: undefined,
      currentRun: undefined,
    })
    return { sessionId: spec.sessionId, generation }
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
    void this.execute(slot, marker, params.prompt.text)
  }

  async cancel(threadId: string, runId: string): Promise<boolean> {
    const slot = this.slots.get(threadId)
    if (slot?.currentRun?.runId !== runId) return false
    slot.currentRun.cancelled = true
    this.clearIdleTimer(slot)
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

  private async execute(slot: RuntimeSlot, marker: { runId: string; cancelled: boolean }, prompt: string): Promise<void> {
    try {
      const result = await slot.harness.run(prompt, {
        sessionId: slot.spec.sessionId,
        onNotification: notification => {
          for (const event of adaptHarnessNotification(notification, { includeUsage: false })) {
            this.push(slot, marker.runId, event)
          }
        },
      })
      if (!marker.cancelled) {
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
        }
        const reason = endReasonFromNotifications(result.notifications)
        const failure = failureFromNotifications(result.notifications)
        if (failure !== undefined || reason === 'protocol_error') {
          this.push(slot, marker.runId, {
            type: 'run.error',
            message: failure?.message ?? 'DeepSeek Harness turn ended with a protocol error',
            ...(failure === undefined
              ? { code: 'PROTOCOL_ERROR' }
              : failure.code === undefined ? {} : { code: failure.code }),
          })
        }
        this.push(slot, marker.runId, {
          type: 'run.completed',
          reason,
        })
      }
    } catch (error) {
      if (!marker.cancelled) {
        this.push(slot, marker.runId, { type: 'run.error', message: errorMessage(error), code: 'HARNESS_RUN_FAILED' })
        this.push(slot, marker.runId, { type: 'run.completed', reason: 'runtime_crashed' })
      }
    } finally {
      if (slot.currentRun === marker) {
        slot.currentRun = undefined
        await this.retainIdle(slot)
      }
    }
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

async function readSessionUsage(slot: RuntimeSlot): Promise<SessionUsageResult | undefined> {
  try {
    return await slot.harness.session(slot.spec.sessionId).usage()
  } catch {
    // Usage is supplementary metadata. A completed answer must still reach
    // the UI when an older/custom runtime does not implement session/usage.
    return undefined
  }
}

function sameSpec(left: RuntimeSpec, right: RuntimeSpec): boolean {
  return left.threadId === right.threadId
    && left.sessionId === right.sessionId
    && left.cwd === right.cwd
    && sameStrings(left.workspacePaths, right.workspacePaths)
    && left.provider === right.provider
    && left.providerName === right.providerName
    && left.apiProtocol === right.apiProtocol
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
  return error instanceof Error ? error.message : String(error)
}
