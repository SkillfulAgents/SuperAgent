import { and, eq, like } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { emailIntegrationState } from '../db/schema'
import { emailMessageSchema } from './config-schema'
import { readEmailState } from './state'
export async function heldEmails(integrationId: string) {
  const rows = await db.select().from(emailIntegrationState).where(and(eq(emailIntegrationState.integrationId, integrationId), like(emailIntegrationState.key, 'held:%'))).limit(100).all()
  const messages = []
  for (const row of rows) {
    const messageId = row.key.slice(5)
    const verdict = await readEmailState(integrationId, `screen:${messageId}`, z.string())
    if (verdict !== 'held') continue
    const message = await readEmailState(integrationId, row.key, emailMessageSchema)
    if (message) messages.push({ id: message.id, from: message.from, subject: message.subject, text: (message.text ?? '').slice(0, 8000), attachments: message.attachments.map(file => file.filename) })
  }
  return messages
}
