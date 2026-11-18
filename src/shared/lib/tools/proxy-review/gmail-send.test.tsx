// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { requestBodyPreview } from '@shared/lib/proxy/review-display'
import { gmailDraftCreateCustomPreview, gmailDraftUpdateCustomPreview, gmailSendCustomPreview, readGmailSend } from './gmail-send'
import { customPreviewFor } from './custom-previews'

const base64url = (mime: string) => Buffer.from(mime.replace(/\n/g, '\r\n')).toString('base64url')

/** The request body as the card gets it: pretty-printed JSON when it parses, cut at 64,000 characters. */
const asCard = (text: string) => requestBodyPreview(new TextEncoder().encode(text).buffer) ?? ''

function cardBody(mime: string, extra: Record<string, unknown> = {}): string {
  return asCard(JSON.stringify({ threadId: 't1', raw: base64url(mime), ...extra }))
}

async function show(requestBody: string) {
  render(<>{await gmailSendCustomPreview.read(requestBody)}</>)
}

const PLAIN = `From: Jeremy <jeremy@example.com>
To: Dana <dana@acme.com>, ops@acme.com
Cc: lead@acme.com
Bcc: archive@elsewhere.io
Reply-To: replies@elsewhere.io
Subject: =?UTF-8?Q?Q3_renewal_=E2=80=94_quote?=
In-Reply-To: <m1@acme.com>
X-Acme-Ticket: 4417
Content-Type: text/plain; charset=utf-8

Hi Dana,
Pricing holds through Nov 15.
`

const LONG = `${PLAIN}${'More pricing detail. '.repeat(3000)}`

describe('a Gmail send on the card', () => {
  it('shows every recipient by its whole address when it has no name, and puts every header and the thread in the details box', async () => {
    expect(customPreviewFor('gmail', 'POST', 'gmail/v1/users/me/messages/send')).toBe(gmailSendCustomPreview)
    expect(gmailSendCustomPreview.title).toBe('Allow sending this email from Gmail?')
    await show(cardBody(PLAIN))
    expect(screen.getByTestId('gmail-send-summary').textContent).toBe('to Dana, ops@acme.com, lead@acme.com, bcc: archive@elsewhere.io')
    const envelope = screen.getByTestId('gmail-send-envelope').textContent
    for (const row of ['reply-to:replies@elsewhere.io', 'subject:Q3 renewal — quote', 'thread:t1', 'in-reply-to:<m1@acme.com>', 'x-acme-ticket:4417']) expect(envelope).toContain(row)
    expect(screen.getByTestId('gmail-send-body').textContent).toBe('Hi Dana,\nPricing holds through Nov 15.')
    expect(screen.queryByTestId('gmail-send-cut')).toBeNull()
    expect(screen.queryByTestId('gmail-send-attachments')).toBeNull()
  })

  it('shows a recipient by address when the From would make it "me", or its name reads as an address', async () => {
    await show(cardBody(`From: Iddo <attacker@evil.com>
To: attacker@evil.com, "ceo@acme.com" <ceo@evil.com>, =?UTF-8?Q?dana=EF=BC=A0acme.com?= <dana@evil.com>
Subject: Note to self
Content-Type: text/plain; charset=utf-8

hi
`))
    expect(screen.getByTestId('gmail-send-summary').textContent).toBe('to attacker@evil.com, ceo@evil.com, dana@evil.com')
  })

  // Lengths one apart cover both unpadded endings: two and three characters past a group of four.
  it.each(['Send $1,000', 'Send $1,0000', 'Send $1,00000'])('keeps the last characters of a raw sent without padding: %s', async (tail) => {
    expect((await readGmailSend(cardBody(PLAIN.replace(/Hi Dana[\s\S]*$/, tail))))?.text).toBe(tail)
  })

  it('shows the start of a body the card cut short, and says the rest is not shown', async () => {
    await show(cardBody(LONG))
    expect(screen.getByTestId('gmail-send-body').textContent).toMatch(/^Hi Dana,\nPricing holds through Nov 15.\nMore pricing detail/)
    expect(screen.getByTestId('gmail-send-summary').textContent).toContain('bcc: archive@elsewhere.io')
    expect(screen.getByTestId('gmail-send-envelope').textContent).toContain('thread:t1')
    expect(screen.getByTestId('gmail-send-cut').textContent).toBe('The rest of the email is not shown.')
  })

  it('draws an HTML body in an inert frame that runs no scripts, loads nothing, and cannot be refreshed into another page', async () => {
    const html = PLAIN.replace('text/plain', 'text/html').replace(/\n\nHi Dana[\s\S]*$/, '\n\n<META http-equiv="refresh" content="0;url=https://phish.example/login"><LINK rel="dns-prefetch" href="//tracker.example"><p>Hi <b>Dana</b></p><script>window.ran = true</script><img src="https://pixel.example/p.gif">\n')
    await show(cardBody(html))
    const frame = screen.getByTestId('email-html')
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(frame.hasAttribute('inert')).toBe(true)
    expect(frame.className).toContain('pointer-events-none')
    const srcdoc = frame.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toMatch(/^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;/)
    expect(srcdoc).not.toMatch(/<meta http-equiv="refresh"|<link\b/i)
    expect(srcdoc).toContain('<x-meta http-equiv="refresh"')
    expect(srcdoc).toContain('<x-link rel="dns-prefetch"')
    expect(srcdoc).toContain('<p>Hi <b>Dana</b></p>')
  })

  it('draws each inline image the card has, and hides the ones it cannot draw', async () => {
    const mime = `From: Jeremy <jeremy@example.com>
To: dana@acme.com
Subject: Chart
Content-Type: multipart/related; boundary=r

--r
Content-Type: text/html

<p><img src="cid:chart"><img src="cid:missing"><img src="https://pixel.example/p.gif"></p>
--r
Content-Type: image/png
Content-ID: <chart>
Content-Transfer-Encoding: base64

${Buffer.from('png').toString('base64')}
--r--
`
    const email = await readGmailSend(cardBody(mime))
    const images = new DOMParser().parseFromString(email?.html ?? '', 'text/html').querySelectorAll('img')
    expect(images[0].getAttribute('src')).toBe(`data:image/png;base64,${Buffer.from('png').toString('base64')}`)
    for (const hidden of [images[1], images[2]]) {
      expect(hidden.getAttribute('src')).toBeNull()
      expect(hidden.style.visibility).toBe('hidden')
    }
  })

  it('lists every web address the HTML names, spelled out or not, and says the email has attachments it does not show', async () => {
    const mime = `From: Jeremy <jeremy@example.com>
To: dana@acme.com
Subject: Invoice
Content-Type: multipart/mixed; boundary=m

--m
Content-Type: text/html

<META http-equiv="refresh" content="0;url=https://phish.example/login"><img src="https://pixel.example/p.gif?u=1&amp;v=2"><a href="https://x.example">x</a>.
<a href="https&#58;//encoded.example/a">e</a><img src="//relative.example/p.gif"><p>a//b</p>
--m
Content-Type: application/pdf
Content-Disposition: attachment; filename=quote.pdf

pdf
--m--
`
    await show(cardBody(mime))
    const list = screen.getByTestId('email-web-addresses')
    expect([...list.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'https://phish.example/login', 'https://pixel.example/p.gif?u=1&v=2', 'https://x.example', 'https://encoded.example/a', '//relative.example/p.gif',
    ])
    expect(screen.getByTestId('gmail-send-attachments').textContent).toBe('Has attachments, not shown.')
  })

  it.each([
    ['headers the card cut off', PLAIN.replace('Bcc:', `To: ${Array.from({ length: 3000 }, (_, i) => `person${i}@acme.com`).join(', ')}\nBcc:`).replace(/^To: Dana.*\n/m, '')],
    ['a Resent-* header', PLAIN.replace('Subject:', 'Resent-To: hidden@elsewhere.io\nSubject:')],
    ['a repeated address header', PLAIN.replace('Subject:', 'Cc: second@elsewhere.io\nSubject:')],
    ['an address header that does not parse', PLAIN.replace('Cc: lead@acme.com', 'Cc: ,')],
    ['a recipient with a name and no address', PLAIN.replace('Cc: lead@acme.com', 'Cc: Lead')],
  ])('draws nothing for %s, leaving the raw request', async (_case, mime) => {
    expect(await readGmailSend(cardBody(mime))).toBeUndefined()
  })

  // Past 64 KB the card's copy is the body as sent, so a key it cannot see could set the raw again.
  it.each([
    ['a raw that ends before the cut copy does', cardBody(PLAIN, { labelIds: ['x'.repeat(70_000)] })],
    ['a key before the raw that sets raw too', asCard(`{"r\\u0061w":"${base64url('To: attacker@evil.com\n\nhi')}","raw":"${base64url(LONG)}"}`)],
    ['a raw inside another object', asCard(`{"payload":{"raw":"${base64url(LONG)}"}}`)],
  ])('draws nothing for %s', async (_case, requestBody) => {
    expect(requestBody.endsWith('…')).toBe(true)
    expect(await readGmailSend(requestBody)).toBeUndefined()
  })

  it('leaves a call no custom preview matches to the raw request and its endpoint title', () => {
    expect(customPreviewFor('gmail', 'POST', 'gmail/v1/users/me/drafts/send')).toBeUndefined()
  })
})

describe('a Gmail draft on the card', () => {
  const draftBody = (mime: string, extra: Record<string, unknown> = {}) => asCard(JSON.stringify({ id: 'd1', ...extra, message: { threadId: 't1', raw: base64url(mime) } }))

  it.each([
    ['POST', 'gmail/v1/users/me/drafts', gmailDraftCreateCustomPreview, 'Allow saving this draft in Gmail?'],
    ['PUT', 'gmail/v1/users/me/drafts/d1', gmailDraftUpdateCustomPreview, 'Allow changing this draft in Gmail?'],
  ] as const)('reads a %s draft as the email it holds', async (method, path, preview, title) => {
    expect(customPreviewFor('gmail', method, path)).toBe(preview)
    expect(preview.title).toBe(title)
    render(<>{await preview.read(draftBody(PLAIN))}</>)
    expect(screen.getByTestId('gmail-send-summary').textContent).toBe('to Dana, ops@acme.com, lead@acme.com, bcc: archive@elsewhere.io')
    expect(screen.getByTestId('gmail-send-envelope').textContent).toContain('thread:t1')
  })

  it('shows the start of a draft the card cut short', async () => {
    const email = await readGmailSend(draftBody(LONG), true)
    expect(email?.cut).toBe(true)
    expect(email?.bcc).toEqual(['archive@elsewhere.io'])
  })

  it('draws nothing for a raw outside the message', async () => {
    expect(await readGmailSend(asCard(JSON.stringify({ raw: base64url(PLAIN) })), true)).toBeUndefined()
  })

  const attacker = base64url('To: attacker@evil.com\n\nhi')
  it.each([
    ['a cut raw outside the message', `{"message":{"threadId":"t1"},"raw":"${base64url(LONG)}"}`],
    ['a cut raw in an object after the message', `{"message":{"threadId":"t1"},"other":{"raw":"${base64url(LONG)}"}}`],
    ['a cut raw in an object after a message that sets the fixed marker', `{"message":{"":0,"threadId":"t1"},"other":{"raw":"${base64url(LONG)}"}}`],
    ['a cut raw after a message key that sets raw too', `{"message":{"r\\u0061w":"${attacker}","raw":"${base64url(LONG)}"}}`],
    ['a cut message after an earlier message', `{"message":{"raw":"${attacker}"},"message":{"threadId":"t1","raw":"${base64url(LONG)}"}}`],
    ['a cut message after an escaped message key', `{"mess\\u0061ge":{"raw":"${attacker}"},"message":{"threadId":"t1","raw":"${base64url(LONG)}"}}`],
  ])('draws nothing for %s', async (_case, body) => {
    const requestBody = asCard(body)
    expect(requestBody.endsWith('…')).toBe(true)
    expect(await readGmailSend(requestBody, true)).toBeUndefined()
  })
})
