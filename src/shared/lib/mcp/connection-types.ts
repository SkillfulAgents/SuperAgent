import type { McpToolInfo } from './types'

export interface McpConnectionDescriptor {
  id: string
  name: string
  url: string
  status: 'active' | 'auth_required' | 'error'
  tools: McpToolInfo[]
}

export interface McpInvocation {
  method: string
  requestPath: string
  toolName: string | null
  isProtocolMethod: boolean
  signal: AbortSignal
}

export type McpAccessResult =
  | { ok: true; policyDecision: string }
  | { ok: false; reason: 'blocked' | 'denied' | 'review_timeout' }

export type McpAuthorization =
  | { ok: true; accessToken: string | null }
  // Credentials could not be refreshed; the connection now requires recovery.
  | { ok: false }

export type McpRecoveryResult =
  | { ok: true }
  | { ok: false; reason: 'replaced'; replacementMcpId: string }
  | { ok: false; reason: 'timeout' | 'dismissed' | 'missing' | 'inactive'; dismissReason?: string }
  | { ok: false; reason: 'reconnect_required'; error: string; message: string; context: Record<string, string> }

/** One request's connection. Ownership, policy and credentials stay with its
 * source; the proxy owns protocol handling, retries, transport and auditing. */
export interface McpConnection {
  readonly descriptor: McpConnectionDescriptor
  authorizeInvocation(invocation: McpInvocation): Promise<McpAccessResult>
  /** Revalidates lifecycle before forwarding. Called again only after a real
   * handshake or recovery; ordinary requests obtain credentials once. */
  authorization(): Promise<McpAuthorization>
  markAuthRequired(message: string): Promise<void>
  recoverAuthorization(signal: AbortSignal): Promise<McpRecoveryResult>
  /** Only upstream outcomes reach this hook, never local rejection/cancellation. */
  reportHealth(available: boolean): Promise<void>
}
