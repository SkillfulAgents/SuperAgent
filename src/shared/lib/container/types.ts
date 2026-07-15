import type { RuntimeOptions } from './runtime-options'

export type ContainerStatus = 'stopped' | 'running'

// Effort levels supported by Claude Agent SDK v0.2.111+.
// 'xhigh' is Opus 4.7 only; 'max' is Opus 4.6/4.7 only.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = typeof EFFORT_LEVELS[number]

// Normalized processing-speed tiers across providers. 'fast' maps to
// Anthropic fast mode / OpenAI priority; 'slow' maps to OpenAI flex.
// 'normal' is the universal default and the only tier every model supports.
export const SPEED_LEVELS = ['slow', 'normal', 'fast'] as const
export type SpeedLevel = typeof SPEED_LEVELS[number]

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
  initialMessageUuid?: string // Optional UUID for message author attribution
  model?: string // Claude model to use for this session
  browserModel?: string // Model for browser subagent
  dashboardBuilderModel?: string // Model for the dashboard-builder subagent
  maxOutputTokens?: number // Max tokens per response (CLAUDE_CODE_MAX_OUTPUT_TOKENS)
  maxThinkingTokens?: number // Max tokens for extended thinking
  maxTurns?: number // Max conversation turns
  maxBudgetUsd?: number // Max cost in USD per session
  customEnvVars?: Record<string, string> // User-defined env vars for the agent process
  maxBrowserTabs?: number // Max browser tabs allowed (default 10)
  effort?: EffortLevel // Initial thinking effort level
  speed?: SpeedLevel // Initial processing speed tier
}

export interface StartOptions {
  envVars?: Record<string, string>
  additionalVolumes?: string[] // Extra -v flag values for bind mounts
  /**
   * Called when a bind mount is dropped at run time because the container
   * runtime can't access it (e.g. a cloud-synced folder the Lima VM helper is
   * denied). Receives the host path so the caller can warn the user. The
   * container is still started without that one mount.
   */
  onMountDropped?: (hostPath: string) => void
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

export interface StopOptions {
  stopTimeoutMs?: number
  killTimeoutMs?: number
  /**
   * Whether to escalate to a runtime-level force-stop (e.g. killing the entire
   * Lima VM) when both `stop` and `kill` time out. Defaults to true.
   *
   * Force-stop kills the shared VM, taking down ALL running agents. That is an
   * acceptable last resort for user-initiated stops (a debug escape hatch — if
   * a container won't die, you want the bigger hammer) and for app shutdown.
   * It is NOT acceptable for the background auto-sleep sweep: reclaiming one
   * idle container should never nuke everyone's active work. Auto-sleep passes
   * `false`, in which case a stuck container is left running and retried on the
   * next cycle.
   */
  escalateToForceStop?: boolean
}

export interface StopResult {
  /** True if we had to force-stop the runtime (e.g. kill the Lima VM). */
  forceStopUsed: boolean
  /**
   * True if the container was actually stopped (gracefully, killed, or via
   * force-stop). False only when stop+kill timed out and force-stop was
   * disabled — the container is still running and should be retried.
   */
  stopped: boolean
}

// Verdict from probing a host-side TCP endpoint from the runner's network side.
// Only 'unreachable' is a proven block; 'unknown' must never fail a launch.
export type HostPortProbeResult = 'reachable' | 'unreachable' | 'unknown'

export interface ContainerClient {
  // Lifecycle management
  start(options?: StartOptions): Promise<void>
  stop(options?: StopOptions): Promise<StopResult>
  stopSync(): void // Synchronous stop for exit handlers

  // Build a -v flag value for a volume mount (hostPath:containerPath with runtime-specific suffix)
  buildVolumeFlag(hostPath: string, containerPath: string): string

  // Host-internal bridge IP that a host-side service must bind to so THIS runner's
  // containers can reach it via host.docker.internal, or null when containers reach
  // the host's loopback directly (e.g. Docker Desktop forwards loopback). Used to
  // forward an unauthenticated host CDP port to the container without ever binding
  // it on 0.0.0.0 (SUP-217).
  getHostBridgeIp(): string | null

  // Probe whether a host-side TCP endpoint (e.g. the CDP proxy bound to
  // getHostBridgeIp()) is actually reachable from the runner's network side,
  // where container-originated traffic comes from. 'unknown' means the runner
  // has no vantage point to test from — callers must treat it as "proceed",
  // never as a failure.
  probeHostPortFromRunner(host: string, port: number): Promise<HostPortProbeResult>

  // Query the container runtime for current state (spawns CLI process)
  // Use containerManager.getCachedInfo() for cached status instead
  getInfoFromRuntime(): Promise<ContainerInfo>

  // Alias for getInfoFromRuntime() - prefer getCachedInfo() from containerManager
  getInfo(): Promise<ContainerInfo>

  // Make HTTP request to container (abstracts away host/port details)
  // Throws if container is not running
  fetch(path: string, init?: RequestInit): Promise<Response>

  // Headers proving the caller is the host — required by the container API,
  // which is also reachable from the agent's own Bash. Callers that dial the
  // container directly (e.g. WebSocket upgrades) must attach these.
  getHostAuthHeaders(): Record<string, string>

  getWebSocketBaseUrl(port: number): string
  getHostApiBaseUrl(): string | Promise<string>

  // Health checks
  waitForHealthy(timeoutMs?: number, knownPort?: number): Promise<boolean>
  isHealthy(knownPort?: number): Promise<boolean>

  // Resource stats (memory, CPU usage)
  getStats(): Promise<ContainerStats | null>

  // Session management (proxied to container API)
  createSession(options: CreateSessionOptions): Promise<ContainerSession>
  getSession(sessionId: string): Promise<ContainerSession | null>
  deleteSession(sessionId: string): Promise<boolean>

  // Message operations
  sendMessage(sessionId: string, content: string, uuid?: string, options?: RuntimeOptions): Promise<void>
  // Cancel a queued (not yet picked up) message by the uuid it was sent with.
  // false = too late (already picked up) or session not live — never throws for that.
  cancelQueuedMessage(sessionId: string, uuid: string): Promise<boolean>
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

// Lima VM defaults (shared between server and UI)
export const DEFAULT_LIMA_VM_MEMORY = '4GiB'
export const VALID_LIMA_VM_MEMORY_OPTIONS = ['2GiB', '4GiB', '6GiB', '8GiB', '12GiB', '16GiB'] as const

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
