export interface HarnessNotification {
  method: string
  params: Record<string, unknown>
}

export interface HarnessNotificationSubscription {
  next(): Promise<HarnessNotification>
  close(): void
}

export interface RunResult {
  sessionId: string
  finalResponse: string
  events: unknown[]
  notifications: HarnessNotification[]
}

export interface SessionUsageResult {
  sessionId: string
  modelId?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  contextTokens?: number
  contextWindow?: number
}

export interface DeepSeekHarnessOptions {
  launch: {
    command: string
    args?: string[]
    cwd?: string
    env?: NodeJS.ProcessEnv
    requestTimeoutMs?: number
    shutdownTimeoutMs?: number
  }
  cwd?: string
  workspacePaths?: string[]
  provider?: string
  model?: string
  maxTokens?: number
}

export declare class DeepSeekHarness {
  constructor(options: DeepSeekHarnessOptions)
  readonly isRuntimeRunning: boolean
  readonly client: {
    request(method: string, params?: object, timeoutMs?: number): Promise<unknown>
    subscribe(filter?: (notification: HarnessNotification) => boolean): HarnessNotificationSubscription
  }
  run(input: string, options?: {
    sessionId?: string
    onNotification?: (notification: HarnessNotification) => void
  }): Promise<RunResult>
  session(sessionId?: string): HarnessSession
  close(): Promise<void>
}

export declare class HarnessSession {
  readonly harness: DeepSeekHarness
  readonly id: string
  run(input: string, options?: {
    onNotification?: (notification: HarnessNotification) => void
  }): Promise<RunResult>
  usage(): Promise<SessionUsageResult>
}
