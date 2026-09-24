import { z } from 'zod'
import { createHash } from 'node:crypto'
import { EmailGatewayClient, clientFor, mailboxSchema } from './gateway-client'
import { emailSetupSchema, emailConfigSchema, parseEmailConfig, emailConfigPatchSchema } from './config-schema'
import type { AgentIntegrationRecord } from '../agent-integrations/types'

export async function provisionEmail(agentSlug: string, ownerUserId: string | null, input: unknown) {
  const setup = emailSetupSchema.parse(input)
  const client = new EmailGatewayClient(ownerUserId)
  const identity = await client.json('/me', z.object({ orgId: z.string(), memberId: z.string() }))
  // Stable across setup retries; different agents cannot adopt the same reservation.
  const key = createHash('sha256').update(JSON.stringify([identity.orgId, identity.memberId, agentSlug, setup.localPart])).digest('hex')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': key }
  const response = await client.request('/mailboxes', { method: 'POST', headers, body: JSON.stringify({ localPart: setup.localPart, name: setup.displayName }) })
  const mailbox = mailboxSchema.parse(await response.json())
  return emailConfigSchema.parse({ ...setup, mailboxId: mailbox.id, address: mailbox.address, platformOrgId: identity.orgId, platformMemberId: identity.memberId })
}
export async function updateEmailMailbox(record: AgentIntegrationRecord, patch: unknown, name?: unknown) {
  const parsed = emailConfigPatchSchema.parse(patch ?? {})
  if (name !== undefined) parsed.displayName = emailSetupSchema.shape.displayName.parse(name)
  const config = emailConfigSchema.parse({ ...parseEmailConfig(record.config), ...parsed })
  if (parsed.displayName !== undefined) await clientFor(record).json(`/mailboxes/${config.mailboxId}`, mailboxSchema, { name: parsed.displayName }, 'PATCH')
  return parsed
}
export async function disableEmailMailbox(record: AgentIntegrationRecord) {
  const config = parseEmailConfig(record.config)
  await clientFor(record).json(`/mailboxes/${config.mailboxId}`, mailboxSchema, { status: 'disabled' }, 'PATCH')
}
