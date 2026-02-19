export type ContainerStatus = 'stopped' | 'running'

// Info returned from Docker
export interface ContainerInfo {
  status: ContainerStatus
  port: number | null
}

export interface ContainerConfig {
  agentId: string
  envVars?: Record<string, string>
  /** Called when a connection error is detected (ECONNREFUSED, etc.) */
  onConnectionError?: () => void
}

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint: string
}

export interface ContainerSession {
  id: string
  createdAt: string
  lastActivity: string
  workingDirectory: string
  slashCommands?: SlashCommandInfo[]
}

export interface StreamMessage {
  type: string
  content: any
  timestamp: Date
  sessionId: string
}

export interface CreateSessionOptions {
  metadata?: Record<string, any>
  systemPrompt?: string
  availableEnvVars?: string[]
  initialMessage: string // Required: first message to send (triggers session ID generation)
  model?: string // Claude model to use for this session
  browserModel?: string // Model for browser subagent
  maxOutputTokens?: number // Max tokens per response (CLAUDE_CODE_MAX_OUTPUT_TOKENS)
  maxThinkingTokens?: number // Max tokens for extended thinking
  maxTurns?: number // Max conversation turns
  maxBudgetUsd?: number // Max cost in USD per session
  customEnvVars?: Record<string, string> // User-defined env vars for the agent process
}

export interface StartOptions {
  envVars?: Record<string, string>
}

// Container resource usage stats
export interface ContainerStats {
  memoryUsageBytes: number
  memoryLimitBytes: number
  memoryPercent: number
  cpuPercent: number
}

// Result from a health check
export interface HealthCheckResult {
  checkName: string
  status: 'ok' | 'warning' | 'critical'
  message?: string
  details?: Record<string, unknown>
}

export interface ContainerClient {
  // Lifecycle management
  start(options?: StartOptions): Promise<void>
  stop(): Promise<void>
  stopSync(): void // Synchronous stop for exit handlers

  // Query the container runtime for current state (spawns CLI process)
  // Use containerManager.getCachedInfo() for cached status instead
  getInfoFromRuntime(): Promise<ContainerInfo>

  // Alias for getInfoFromRuntime() - prefer getCachedInfo() from containerManager
  getInfo(): Promise<ContainerInfo>

  // Make HTTP request to container (abstracts away host/port details)
  // Throws if container is not running
  fetch(path: string, init?: RequestInit): Promise<Response>

  // Health checks
  waitForHealthy(timeoutMs?: number): Promise<boolean>
  isHealthy(): Promise<boolean>

  // Resource stats (memory, CPU usage)
  getStats(): Promise<ContainerStats | null>

  // Session management (proxied to container API)
  createSession(options: CreateSessionOptions): Promise<ContainerSession>
  getSession(sessionId: string): Promise<ContainerSession | null>
  deleteSession(sessionId: string): Promise<boolean>

  // Message operations
  sendMessage(sessionId: string, content: string): Promise<void>
  getMessages(sessionId: string): Promise<any[]>
  interruptSession(sessionId: string): Promise<boolean>

  // Streaming - returns unsubscribe function and a ready promise
  subscribeToStream(
    sessionId: string,
    callback: (message: StreamMessage) => void
  ): { unsubscribe: () => void; ready: Promise<void> }

  // Events
  on(event: 'error', callback: (error: Error) => void): void
  on(event: 'message', callback: (sessionId: string, message: any) => void): void
  off(event: string, callback: (...args: any[]) => void): void
}

// Runtime readiness types

export type RuntimeReadinessStatus =
  | 'CHECKING'
  | 'RUNTIME_UNAVAILABLE'
  | 'PULLING_IMAGE'
  | 'READY'
  | 'ERROR'

export interface ImagePullProgress {
  /** Human-readable status, e.g. "Pulling image... 3 of 7 layers" */
  status: string
  /** Layer-based percentage (completedLayers / totalLayers * 100), null if not yet determined */
  percent: number | null
  completedLayers: number
  totalLayers: number
}

export interface RuntimeReadiness {
  status: RuntimeReadinessStatus
  message: string
  pullProgress: ImagePullProgress | null
}
