export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type RpcRequest = {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Json
}

export type RpcResponse = {
  jsonrpc: '2.0'
  id: string | number
  result?: Json
  error?: { code: number; message: string; data?: Json }
}

export type RpcNotification = { jsonrpc: '2.0'; method: string; params?: Json }

export type RpcId = string | number

export type Thread = {
  id: string
  parentThreadId?: string
  status: 'idle' | 'running' | 'closed'
  turns: Turn[]
}

export type Turn = {
  id: string
  threadId: string
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  items: Item[]
}

export type Item = {
  id: string
  type: 'userMessage' | 'agentMessage' | 'toolCall' | 'toolResult' | 'systemMessage'
  text?: string
  /** Product display classification for non-model timeline items. */
  messageType?: string
  sourceSeq?: number
}

export type TurnPage = {
  data: Turn[]
  nextCursor: string | null
}

export type DshSkill = {
  name: string
  description: string
  whenToUse?: string
  modelInvocable?: boolean
}

/** Wire-form image upload. The app-server admits it before appending a DSH event. */
export type DshImageAttachment = {
  type: 'image'
  mediaType: string
  data: string
  name?: string
}

export type DshCommandAttachment = DshImageAttachment | {
  type: 'file'
  receiptId: string
}

/** DSH-owned work that may continue after command/done. */
export type DshCommandEffects = {
  turn: 'none' | 'steer' | 'goal-round'
  followup?: boolean
}

export type DshCommandResult = {
  execution: Json
  effects?: DshCommandEffects
  export?: { filename: string; content: string }
}

export type ThreadLaunchConfig = {
  cwd?: string
  workspacePaths?: string[]
  provider?: string
  model?: string
  maxTokens?: number
  agentPreset?: string
  permissionMode?: string
}

export interface HarnessAdapter {
  startThread(threadId: string, config?: ThreadLaunchConfig): Promise<Thread>
  resumeThread(threadId: string, config?: ThreadLaunchConfig): Promise<Thread>
  forkThread(sourceId: string, boundarySeq?: number, childId?: string): Promise<Thread>
  readThread(threadId: string, includeTurns: boolean): Promise<Thread>
  listThreads(): Promise<Thread[]>
  listTurns(threadId: string, cursor?: string, limit?: number): Promise<TurnPage>
  listEvents(threadId: string, afterSeq?: number, limit?: number): Promise<{ data: Json[]; nextCursor: string | null }>
  startTurn(threadId: string, input: Json): Promise<Turn>
  steerTurn(threadId: string, input: Json, clientMessageId?: string): Promise<boolean>
  interruptTurn(threadId: string): Promise<{ interrupted: boolean }>
  closeThread(threadId: string): Promise<{ closed: boolean }>
  archiveThread(threadId: string): Promise<{ archived: boolean }>
  executeCommand(threadId: string, command: string, attachments?: DshCommandAttachment[]): Promise<Json | DshCommandResult>
  listSkills(threadId: string): Promise<{ skills: DshSkill[] }>
  subscribe(listener: (event: RpcNotification) => void): () => void
}
