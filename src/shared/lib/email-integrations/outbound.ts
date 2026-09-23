import { readIntegrationState, writeIntegrationState } from '../agent-integrations/state-store'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { agentRegistry } from '../agent-actor'
import type { AgentIntegrationRecord, IntegrationTool } from '../agent-integrations/types'
import { parseEmailConfig, emailMessageSchema, emailSendSchema } from './config-schema'
import { clientFor } from './gateway-client'

import { sanitizeUploadFilename } from '../utils/path-safety'
export const emailToolSchema = z.object({
  to: z.array(z.string().email()).optional(), cc: z.array(z.string().email()).default([]), bcc: z.array(z.string().email()).default([]),
  subject: z.string().optional(), reply_to_message_id: z.string().uuid().optional(), reply_all: z.boolean().default(false),
  attachment_paths: z.array(z.string()).max(10).default([]), idempotency_key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/, 'Use letters, numbers, dots, underscores, colons or hyphens'),
}).strict().refine(value => !!value.reply_to_message_id || (!!value.to?.length && !!value.subject), 'New emails require recipients and a subject')
const intentSchema = z.object({ hash: z.string(), input: emailSendSchema })
const pending = new Map<string, Promise<unknown>>()
/** Preserve uploaded IDs across retries so a stable gateway idempotency key has a stable payload. */
export async function sendToolEmail(record: AgentIntegrationRecord, input: z.infer<typeof emailToolSchema>, text: string, tool: IntegrationTool) {
  const key = `send:${createHash('sha256').update(input.idempotency_key).digest('hex')}`
  const lock = `${record.id}:${key}`
  const previous = pending.get(lock) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    const hash = createHash('sha256').update(JSON.stringify({ input, text })).digest('hex')
    const saved = await readIntegrationState(record.id, key, intentSchema)
    if (saved && saved.hash !== hash) throw new Error('Email idempotency key already used with different content')
    let send = saved?.input
    if (!send) {
      const config = parseEmailConfig(record.config)
      const client = clientFor(record)
      const attachmentIds: string[] = []
      let size = 0
      for (const path of input.attachment_paths) {
        const data = await agentRegistry.get(record.agentSlug).files.getDoc(path)
        if (data === null || data.byteLength > 5 * 1024 * 1024) throw new Error('Attachment is missing or exceeds 5 MiB')
        size += data.byteLength
        if (size > 10 * 1024 * 1024) throw new Error('Total attachments exceed 10 MiB')
        const response = await client.request(`/mailboxes/${config.mailboxId}/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': sanitizeUploadFilename(path).replace(/[^\x20-\x7e]/g, '_') }, body: new Uint8Array(data) })
        attachmentIds.push(z.object({ id: z.string().uuid() }).parse(await response.json()).id)
      }
      send = emailSendSchema.parse({ to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text, replyToMessageId: input.reply_to_message_id, replyAll: input.reply_all, attachmentIds, idempotencyKey: input.idempotency_key })
      await writeIntegrationState(record.id, key, intentSchema, { hash, input: send })
    }
    return emailMessageSchema.parse(await tool.execute(send))
  })
  pending.set(lock, run)
  try { return await run } finally { if (pending.get(lock) === run) pending.delete(lock) }
}
