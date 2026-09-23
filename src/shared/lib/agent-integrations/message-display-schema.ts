import { z } from 'zod'

/**
 * Display metadata for a message an integration delivered into an agent session.
 *
 * The host stores it beside the transcript, keyed by the message uuid; the text
 * the agent received is never changed. Only the host writes it, so a card can
 * only be drawn for a message the host actually delivered: text that imitates a
 * card is still ordinary text. Every string is external content and renders as
 * text, never as markup or trusted instructions.
 */
export const INTEGRATION_MESSAGE_DISPLAY_VERSION = 1

export const INTEGRATION_MESSAGE_LIMITS = {
  requestText: 4000,
  description: 600,
  label: 200,
  name: 200,
  url: 2048,
} as const

/** An https link with no embedded credentials; anything else is dropped. */
export function isSafeIntegrationLink(value: string): boolean {
  if (value.length > INTEGRATION_MESSAGE_LIMITS.url) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

/** Returns the link when it is safe to show, otherwise undefined. */
export function safeIntegrationLink(value: string | null | undefined): string | undefined {
  return value && isSafeIntegrationLink(value) ? value : undefined
}

/** Shortens external text for a preview; the agent still gets the full text. */
export function clampIntegrationText(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`
}

/** An ISO timestamp for `sentAt`, or undefined when the provider's value does not parse. */
export function integrationTimestamp(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined
  const time = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

const safeLink = z.string().refine(isSafeIntegrationLink, 'Links must be https without credentials')
const label = z.string().max(INTEGRATION_MESSAGE_LIMITS.label)

export const integrationMessagePersonSchema = z.object({
  name: z.string().min(1).max(INTEGRATION_MESSAGE_LIMITS.name),
  /** A public image; providers never pass a credential-bearing URL here. */
  avatarUrl: safeLink.optional(),
})

/** The conversation or work item the message belongs to. */
export const integrationMessageSourceSchema = z.object({
  kind: z.enum(['direct', 'group', 'channel', 'thread', 'task']),
  url: safeLink.optional(),
  /** Short reference, e.g. an issue key. */
  identifier: label.optional(),
  /** Channel, chat or issue title. */
  title: label.optional(),
  /** Workspace, team or account the source lives in. */
  workspace: label.optional(),
  status: z.object({
    name: label,
    /** Normalized workflow stage for task managers. */
    category: z.enum(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']).optional(),
  }).optional(),
})

/** Work-item fields a task-manager preview can show. */
export const integrationMessageTaskSchema = z.object({
  description: z.string().max(INTEGRATION_MESSAGE_LIMITS.description).optional(),
  /** 0 = none, 1 = urgent … 4 = low. */
  priority: z.object({ level: z.number().int().min(0).max(4), label }).optional(),
  assignee: label.optional(),
  delegate: label.optional(),
  team: label.optional(),
  project: label.optional(),
  labels: z.array(label).max(20).optional(),
})

/** Envelope facts for an email preview; never raw HTML, Bcc or attachment URLs. */
export const integrationMessageEmailSchema = z.object({
  from: z.string().max(520),
  to: z.array(z.string().max(520)).max(20),
  cc: z.array(z.string().max(520)).max(20),
  replyTo: z.array(z.string().max(520)).max(20),
  recipientsTruncated: z.boolean().optional(),
  quotedText: z.string().max(INTEGRATION_MESSAGE_LIMITS.requestText).optional(),
  attachmentCount: z.number().int().nonnegative(),
})

/** What a provider describes; the host adds the integration identity. */
export const integrationMessagePresentationSchema = z.object({
  event: z.object({
    /** Provider-neutral event key, e.g. `message`, `assigned`, `comment`. */
    type: z.string().min(1).max(64),
    /** Human wording, e.g. "Mentioned you in a comment". */
    label,
  }),
  /** What a person wrote. Absent when the event carries no human text (an assignment). */
  request: z.object({
    text: z.string().max(INTEGRATION_MESSAGE_LIMITS.requestText),
    author: integrationMessagePersonSchema.optional(),
    sentAt: z.string().datetime({ offset: true }).optional(),
    url: safeLink.optional(),
  }).optional(),
  source: integrationMessageSourceSchema,
  task: integrationMessageTaskSchema.optional(),
  email: integrationMessageEmailSchema.optional(),
})

export const integrationMessageDisplaySchema = integrationMessagePresentationSchema.extend({
  version: z.literal(INTEGRATION_MESSAGE_DISPLAY_VERSION),
  integration: z.object({
    id: z.string().min(1).max(200),
    /** Name when the message arrived; kept after a rename or deletion. */
    name: z.string().min(1).max(INTEGRATION_MESSAGE_LIMITS.name),
    /** Provider key; the renderer resolves the icon and preview from it. */
    provider: z.string().min(1).max(64),
    family: z.string().min(1).max(64),
  }),
})

export type IntegrationMessagePerson = z.infer<typeof integrationMessagePersonSchema>
export type IntegrationMessageSource = z.infer<typeof integrationMessageSourceSchema>
export type IntegrationMessageTask = z.infer<typeof integrationMessageTaskSchema>
export type IntegrationMessagePresentation = z.infer<typeof integrationMessagePresentationSchema>
export type IntegrationMessageDisplay = z.infer<typeof integrationMessageDisplaySchema>
