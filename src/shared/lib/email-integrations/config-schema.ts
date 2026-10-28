import { z } from 'zod'
import { integrationRelayConfigShape } from '../agent-integrations/transport'

export const EMAIL_PROVIDER = 'platform-email' as const
export const EMAIL_GATEWAY_URL = 'https://email-gateway.datawizz.workers.dev'
export const EMAIL_ACCESS_LEVELS = ['agent-users', 'agent-users-and-replies', 'allowed-domains', 'anyone'] as const
export const emailAccessSchema = z.enum(EMAIL_ACCESS_LEVELS)
export type EmailAccessLevel = z.infer<typeof emailAccessSchema>
const domain = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter an exact domain, such as company.com')
export const emailPolicySchema = z.object({
  accessLevel: emailAccessSchema.default('agent-users-and-replies'),
  allowedDomains: z.array(domain).max(50).default([]),
}).refine(v => v.accessLevel !== 'allowed-domains' || v.allowedDomains.length > 0, 'Add at least one allowed domain')
export const emailSetupSchema = z.object({
  localPart: z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, 'Use letters, numbers, dots, underscores or hyphens'),
  displayName: z.string().trim().min(1).max(200).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Name cannot contain control characters'),
  accessLevel: emailAccessSchema.default('agent-users-and-replies'),
  allowedDomains: z.array(domain).max(50).default([]),
}).strict().refine(v => v.accessLevel !== 'allowed-domains' || v.allowedDomains.length > 0, 'Add at least one allowed domain')
export const emailIntegrationConfigSchema = emailSetupSchema.safeExtend({
  mailboxId: z.string().uuid(),
  address: z.string().email(),
})
/** A Standard Webhooks secret the gateway accepts: `whsec_` and 24–64 base64-encoded bytes. */
export const emailWebhookSecretSchema = z.string().regex(/^whsec_[A-Za-z0-9+/]{32,88}={0,2}$/)
export const emailConfigSchema = emailIntegrationConfigSchema.safeExtend({
  eventCursor: z.number().int().nonnegative().default(0),
  platformOrgId: z.string().min(1),
  platformMemberId: z.string().min(1),
  /** The relay endpoint the gateway posts this mailbox's events to; shared by every mailbox in its scope, set on the first connect with a relay. */
  ...integrationRelayConfigShape,
  /** Signs those posts. Generated with the endpoint, shared with it, and never shown. */
  webhookSecret: emailWebhookSecretSchema.optional(),
})
export type EmailIntegrationConfig = z.infer<typeof emailIntegrationConfigSchema>
export type EmailConfig = z.infer<typeof emailConfigSchema>
export const emailConfigPatchSchema = z.object({
  displayName: emailSetupSchema.shape.displayName.optional(),
  accessLevel: emailAccessSchema.optional(),
  allowedDomains: z.array(domain).max(50).optional(),
}).strict()

const authentication = z.object({ spf: z.string().optional(), dkim: z.string().optional(), dmarc: z.string().optional() }).nullable().optional()
export const emailMessageSchema = z.object({
  id: z.string(), mailboxId: z.string(), threadId: z.string(), direction: z.enum(['inbound', 'outbound']),
  messageId: z.string().nullable(), replyToMessageId: z.string().nullable(),
  from: z.string(), to: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()), replyTo: z.array(z.string()),
  subject: z.string().nullable(), text: z.string().nullable(), html: z.string().nullable(),
  status: z.string(), createdAt: z.number(), authentication,
  attachments: z.array(z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number() })).default([]),
})
export type EmailMessage = z.infer<typeof emailMessageSchema>
export const emailSendSchema = z.object({
  to: z.array(z.string().email()).max(20).optional(), cc: z.array(z.string().email()).max(20).default([]), bcc: z.array(z.string().email()).max(20).default([]),
  subject: z.string().max(998).regex(/^[^\r\n]*$/).optional(), text: z.string().min(1).max(131072),
  /** Host-rendered alternative to `text`; the agent's own sends are text only. */
  html: z.string().max(131072).optional(),
  replyToMessageId: z.string().uuid().optional(), replyAll: z.boolean().default(false),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  idempotencyKey: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/, 'Use letters, numbers, dots, underscores, colons or hyphens'),
}).strict()
export type EmailSend = z.infer<typeof emailSendSchema>

export function parseEmailConfig(value: string): EmailConfig {
  try { return emailConfigSchema.parse(JSON.parse(value)) }
  catch { throw new Error('Invalid stored email configuration') }
}

export function parseEmailIntegrationConfig(value: string): EmailIntegrationConfig {
  try { return emailIntegrationConfigSchema.loose().parse(JSON.parse(value)) }
  catch { throw new Error('Invalid stored email configuration') }
}

export const emailDraftSchema = z.object({ action: z.enum(['send', 'none']), text: z.string().max(131072) }).strict()
  .refine(value => value.action === 'none' || !!value.text.trim(), 'An email needs a body')
