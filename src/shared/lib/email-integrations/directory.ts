import { and, asc, eq, isNull, or } from 'drizzle-orm'
import { db } from '../db'
import { user } from '../db/schema'
import { isAuthMode } from '../auth/mode'
import { getPlatformAuthStatus } from '../services/platform-auth-service'
import { emailAddress, inboundAllowed, recipientAllowed, wasContacted } from './policy'
import type { EmailIntegrationConfig, EmailMessage } from './config-schema'

export const EMAIL_CONVERSATION_LIMIT = 20
export const EMAIL_CONTACT_LIMIT = 100
export const EMAIL_HISTORY_THREAD_LIMIT = 50
export interface EmailHistoryPage { threads: EmailMessage[][]; truncated: boolean }

export async function workspaceEmailContacts() {
  if (!isAuthMode()) {
    const auth = getPlatformAuthStatus()
    return { items: auth.email ? [{ email: auth.email, name: auth.email }] : [], truncated: false }
  }
  const rows = await db.select({ email: user.email, name: user.name }).from(user)
    .where(and(eq(user.emailVerified, true), or(eq(user.banned, false), isNull(user.banned))))
    .orderBy(asc(user.name), asc(user.id)).limit(1001).all()
  return { items: rows.slice(0, 1000), truncated: rows.length > 1000 }
}

export function emailDirectory(config: EmailIntegrationConfig, members: ReadonlySet<string>, workspace: Awaited<ReturnType<typeof workspaceEmailContacts>>, history: EmailHistoryPage) {
  const contacts = new Map<string, { id: string; name: string; email: string; source: string }>()
  const allowed = (value: string) => {
    const address = emailAddress(value)
    return address && address !== config.address.toLowerCase() && recipientAllowed(config, address, members) ? address : null
  }
  for (const row of workspace.items) {
    const address = allowed(row.email)
    if (address) contacts.set(address, { id: address, email: address, name: row.name, source: 'workspace' })
  }
  const conversations: { id: string; name: string; participants: string[]; replyToMessageId: string; updatedAt: number }[] = []
  for (const thread of history.threads) {
    const eligible = thread.filter(mail => mail.direction === 'outbound'
      ? ['sent', 'delivered', 'delivery_delayed', 'queued'].includes(mail.status)
      : inboundAllowed(config, mail, members, wasContacted(mail, thread)))
    for (const mail of eligible) {
      // Bcc on outbound messages belongs to this mailbox, never to another agent.
      const values = mail.direction === 'outbound' ? [...mail.to, ...mail.cc, ...mail.bcc] : [mail.from, ...mail.replyTo, ...mail.to, ...mail.cc]
      for (const value of values) {
        const address = allowed(value)
        if (address && !contacts.has(address)) contacts.set(address, { id: address, email: address, name: address, source: 'previous-correspondence' })
      }
    }
    const parent = [...eligible].reverse().find(mail => {
      const recipients = mail.direction === 'outbound' ? mail.to : mail.replyTo.length ? mail.replyTo : [mail.from]
      return recipients.length > 0 && recipients.every(value => !!allowed(value))
    })
    if (!parent) continue
    conversations.push({ id: parent.threadId, name: parent.subject ?? '(no subject)',
      participants: [...new Set(eligible.flatMap(mail => [mail.from, ...mail.to, ...mail.cc]).map(allowed).filter((value): value is string => !!value))],
      replyToMessageId: parent.id, updatedAt: parent.createdAt })
  }
  conversations.sort((a, b) => b.updatedAt - a.updatedAt)
  return {
    users: { items: [...contacts.values()].slice(0, EMAIL_CONTACT_LIMIT), truncated: workspace.truncated || history.truncated || contacts.size > EMAIL_CONTACT_LIMIT },
    channels: { items: conversations.slice(0, EMAIL_CONVERSATION_LIMIT), truncated: history.truncated || conversations.length > EMAIL_CONVERSATION_LIMIT },
  }
}
