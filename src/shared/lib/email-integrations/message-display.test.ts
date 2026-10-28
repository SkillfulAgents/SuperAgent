import { describe, expect, it } from 'vitest'
import { integrationMessagePresentationSchema } from '../agent-integrations/message-display-schema'
import { emailMessageSchema } from './config-schema'
import { describeEmailMessage, splitEmailQuote } from './message-display'

const mail = emailMessageSchema.parse({ id: 'mail-1', mailboxId: 'box-1', threadId: 'thread-1', direction: 'inbound', messageId: '<mail@example.com>', replyToMessageId: null, from: '"Ada Lovelace" <ada@example.com>', to: ['Assistant <assistant@company.ongamut.so>'], cc: ['Grace <grace@example.com>'], bcc: ['private@example.com'], replyTo: ['team@example.com'], subject: 'Launch checklist', text: null, html: null, status: 'received', createdAt: 1790114400000 })

describe('email message display', () => {
  it('describes the envelope and splits trailing quoted history without changing the input', () => {
    const text = 'Please check the launch plan.\n\nOn Tue, Sep 22, 2026, Assistant wrote:\n> The draft is ready.\n> Please review.'
    const display = describeEmailMessage(mail, text)
    expect(integrationMessagePresentationSchema.parse(display)).toEqual(display)
    expect(display).toMatchObject({ source: { kind: 'thread', title: 'Launch checklist' }, request: { author: { name: 'Ada Lovelace' }, text: 'Please check the launch plan.' }, email: { from: mail.from, to: mail.to, cc: mail.cc, replyTo: mail.replyTo, quotedText: 'On Tue, Sep 22, 2026, Assistant wrote:\n> The draft is ready.\n> Please review.' } })
    expect(JSON.stringify(display)).not.toContain('private@example.com')
    expect(display).not.toHaveProperty('source.url')
  })
  it('keeps inline answers and quote-only messages visible', () => {
    for (const text of ['> Is the release ready?\nYes, it is.', '> Please approve the release.', 'Just a normal message.']) {
      expect(splitEmailQuote(text)).toEqual({ body: text })
    }
  })
  it('handles wrapped attributions and does not hide unquoted follow-up text', () => {
    expect(splitEmailQuote('Yes.\n\nOn Tue, Assistant\n<assistant@example.com> wrote:\n> Ready?')).toEqual({ body: 'Yes.', quote: 'On Tue, Assistant\n<assistant@example.com> wrote:\n> Ready?' })
    const text = 'Yes.\n\nOn Tue, Assistant wrote:\n> Ready?\nOne more thing: wait until Friday.'
    expect(splitEmailQuote(text)).toEqual({ body: text })
  })
  it('bounds large previews and omits transport IDs, HTML and attachment URLs', () => {
    const display = describeEmailMessage({ ...mail, from: 'a'.repeat(1000), subject: 's'.repeat(1000), to: Array(30).fill('a'.repeat(800)), html: '<img src="https://tracker.example/pixel">', attachments: [{ id: 'secret-file-id', filename: 'report.pdf', size: 20, contentType: 'application/pdf' }] }, 'x'.repeat(6000))
    expect(integrationMessagePresentationSchema.safeParse(display).success).toBe(true)
    expect(display.email).toMatchObject({ attachmentCount: 1, recipientsTruncated: true })
    expect(display.email?.to).toHaveLength(20)
    expect(display.request?.text).toHaveLength(4000)
    expect(JSON.stringify(display)).not.toMatch(/tracker|secret-file-id|mail-1|box-1/)
  })
  it('handles empty subjects, attachment-only emails and invalid dates', () => {
    const display = describeEmailMessage({ ...mail, subject: null, createdAt: NaN }, '')
    expect(display.source.title).toBe('(No subject)')
    expect(display.request?.text).toBe('')
    expect(display.request?.sentAt).toBeUndefined()
  })
})
