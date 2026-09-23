import type { IntegrationSessionContext } from '../agent-integrations/types'
import { getAgentIntegration } from '../services/agent-integration-service'
import { readEmailState } from './state'
import { emailThreadStateSchema, parseEmailIntegrationConfig } from './config-schema'
import { and, eq, inArray, or, isNull } from 'drizzle-orm'
import { db } from '../db'
import { agentAcl, user } from '../db/schema'
import { isAuthMode } from '../auth/mode'
import { getPlatformAuthStatus, getPlatformAccessToken } from '../services/platform-auth-service'
import type { EmailIntegrationConfig, EmailMessage } from './config-schema'

/** Gateway-normalized addresses, with optional display names. Reject ambiguity. */
export function emailAddress(value: string): string | null {
  if (/[\r\n]/.test(value)) return null
  const address = value.match(/<([^<>]+)>\s*$/)?.[1] ?? value.trim()
  return /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(address) ? address.toLowerCase() : null
}
export async function agentUserEmails(agentSlug: string): Promise<Set<string>> {
  if (!isAuthMode()) {
    const address = getPlatformAuthStatus().email
    return new Set(address ? [address.toLowerCase()] : [])
  }
  const rows = await db.select({ email: user.email }).from(user).where(and(
    eq(user.emailVerified, true), or(eq(user.banned, false), isNull(user.banned)),
    or(eq(user.role, 'admin'), inArray(user.id, db.select({ id: agentAcl.userId }).from(agentAcl).where(and(eq(agentAcl.agentSlug, agentSlug), inArray(agentAcl.role, ['owner', 'user']))))),
  )).all()
  return new Set(rows.map(row => row.email.toLowerCase()))
}
export function recipientAllowed(config: EmailIntegrationConfig, value: string, members: ReadonlySet<string>): boolean {
  const address = emailAddress(value)
  if (!address) return false
  if (config.accessLevel === 'allowed-domains') return config.allowedDomains.includes(address.split('@')[1])
  if (config.accessLevel === 'agent-users') return members.has(address)
  return true
}
export function inboundAllowed(config: EmailIntegrationConfig, message: EmailMessage, members: ReadonlySet<string>, contacted: boolean): boolean {
  const sender = emailAddress(message.from)
  if (!sender || message.direction !== 'inbound' || message.status === 'automated') return false
  // Only the provider API's attestation counts, never sender-supplied headers.
  if (config.accessLevel !== 'anyone' && message.authentication?.dmarc !== 'pass') return false
  if (config.accessLevel === 'allowed-domains') return recipientAllowed(config, sender, members)
  if (config.accessLevel === 'agent-users') return members.has(sender)
  return config.accessLevel === 'anyone' || members.has(sender) || contacted
}
export function wasContacted(message: EmailMessage, history: EmailMessage[]): boolean {
  const sender = emailAddress(message.from)
  return !!sender && history.some(previous => previous.direction === 'outbound' && previous.threadId === message.threadId
    && previous.createdAt < message.createdAt && !!previous.messageId && ['sent', 'delivered', 'delivery_delayed'].includes(previous.status)
    && [...previous.to, ...previous.cc, ...previous.bcc].some(address => emailAddress(address) === sender))
}
export function platformConnected() { return !!getPlatformAccessToken() }

export class EmailPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'EmailPolicyError' }
}

export async function emailSessionAllowed(context: IntegrationSessionContext): Promise<boolean> {
  const record = await getAgentIntegration(context.integration.id)
  if (!record || record.status !== 'active') return false
  const state = await readEmailState(record.id, `thread:${context.externalId}`, emailThreadStateSchema)
  if (!state) return false
  const config = parseEmailIntegrationConfig(record.config)
  const members = await agentUserEmails(record.agentSlug)
  if (state.message.direction === 'outbound') return [...state.message.to, ...state.message.cc, ...state.message.bcc].every(value => recipientAllowed(config, value, members))
  return inboundAllowed(config, state.message, members, state.contacted)
}
