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
  type: 'userMessage' | 'agentMessage' | 'toolCall' | 'toolResult'
  text?: string
  sourceSeq?: number
}

export type TurnPage = {
  data: Turn[]
  nextCursor: string | null
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
  interruptTurn(threadId: string): Promise<{ interrupted: boolean }>
  closeThread(threadId: string): Promise<{ closed: boolean }>
  subscribe(listener: (event: RpcNotification) => void): () => void
}
