/**
 * Wake hints for one mailbox: `events:email:mailbox:{mailboxId}:wake`. The
 * mailbox's connection polls when one arrives. Its installation's durable
 * event cursor stays the only record of what was read and handed over, so a
 * wake that is missed, repeated or out of order changes nothing but timing:
 * the 30-second poll and every connect read from the cursor anyway.
 */
import { z } from 'zod'
import { defineTopic } from '../app-state'

/** The gateway stream events that wake a mailbox. `ready` opens every stream, so a reconnect polls. */
export const EMAIL_WAKE_KINDS = ['ready', 'message.received', 'thread.reconciled'] as const

export const emailMailboxWakeSchema = z.object({
  mailboxId: z.string().min(1),
  kind: z.enum(EMAIL_WAKE_KINDS),
  /** The gateway cursor of the event, when the wake is for one: the poll is done once the stored cursor reaches it. */
  cursor: z.number().int().positive().optional(),
})
export type EmailMailboxWake = z.infer<typeof emailMailboxWakeSchema>

/** Channel: `emailMailboxWake.channel(mailboxId)`. */
export const emailMailboxWake = defineTopic({ name: 'events:email:mailbox:wake', schema: emailMailboxWakeSchema })
