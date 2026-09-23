import { readIntegrationState, listIntegrationStateKeys } from '../agent-integrations/state-store'
import { z } from 'zod'
import { emailMessageSchema } from './config-schema'

export async function heldEmails(integrationId: string) {
  const rows = await listIntegrationStateKeys(integrationId, { prefix: 'held:', limit: 100 })
  const messages = []
  for (const row of rows) {
    const messageId = row.key.slice(5)
    const verdict = await readIntegrationState(integrationId, `screen:${messageId}`, z.string())
    if (verdict !== 'held') continue
    const message = await readIntegrationState(integrationId, row.key, emailMessageSchema)
    if (message) messages.push({ id: message.id, from: message.from, subject: message.subject, text: (message.text ?? '').slice(0, 8000), attachments: message.attachments.map(file => file.filename) })
  }
  return messages
}
