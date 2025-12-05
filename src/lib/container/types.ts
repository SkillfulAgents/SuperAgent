export type ContainerStatus = 'stopped' | 'running'

// Info returned from Docker
export interface ContainerInfo {
  status: ContainerStatus
  port: number | null
}

export interface ContainerConfig {
  agentId: string
  envVars?: Record<string, string>
}

export interface ContainerSession {
  id: string
  createdAt: string
  lastActivity: string
  workingDirectory: string
}

export interface StreamMessage {
  type: string
  content: any
  timestamp: Date
  sessionId: string
}

export interface ContainerClient {
  // Lifecycle management
  start(): Promise<void>
  stop(): Promise<void>
  stopSync(): void // Synchronous stop for exit handlers

  // Query Docker for current state (single source of truth)
  getInfo(): Promise<ContainerInfo>

  // Health checks
  waitForHealthy(timeoutMs?: number): Promise<boolean>
  isHealthy(): Promise<boolean>

  // Session management (proxied to container API)
  createSession(metadata?: Record<string, any>): Promise<ContainerSession>
  getSession(sessionId: string): Promise<ContainerSession | null>
  deleteSession(sessionId: string): Promise<boolean>

  // Message operations
  sendMessage(sessionId: string, content: string): Promise<void>
  getMessages(sessionId: string): Promise<any[]>
  interruptSession(sessionId: string): Promise<boolean>

  // Streaming - returns unsubscribe function
  subscribeToStream(
    sessionId: string,
    callback: (message: StreamMessage) => void
  ): () => void

  // Events
  on(event: 'error', callback: (error: Error) => void): void
  on(event: 'message', callback: (sessionId: string, message: any) => void): void
  off(event: string, callback: (...args: any[]) => void): void
}
