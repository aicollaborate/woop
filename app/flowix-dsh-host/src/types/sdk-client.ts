export interface HarnessNotification {
  method: string
  params: Record<string, unknown>
}

export interface RunResult {
  sessionId: string
  finalResponse: string
  events: unknown[]
  notifications: HarnessNotification[]
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
  run(input: string, options?: {
    sessionId?: string
    onNotification?: (notification: HarnessNotification) => void
  }): Promise<RunResult>
  close(): Promise<void>
}
