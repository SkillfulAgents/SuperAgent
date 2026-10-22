// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { requestBodyPreview } from '@shared/lib/proxy/review-display'
import { gmailSendLook, readGmailSend } from './gmail-send'
import { requestLookFor } from './request-looks'

/** The request body as the card gets it: pretty-printed JSON, cut at 64,000 characters. */
function cardBody(mime: string, extra: Record<string, unknown> = {}): string {
  const raw = Buffer.from(mime.replace(/\n/g, '\r\n')).toString('base64url')
  return requestBodyPreview(new TextEncoder().encode(JSON.stringify({ threadId: 't1', raw, ...extra })).buffer) ?? ''
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

describe('a Gmail send on the card', () => {
  it('shows every recipient by its whole address when it has no name, and puts every header and the thread in the details box', async () => {
    expect(requestLookFor('gmail', 'POST', 'gmail/v1/users/me/messages/send')).toBe(gmailSendLook)
    expect(gmailSendLook.title).toBe('Allow sending this email from Gmail?')
    render(<gmailSendLook.Look requestBody={cardBody(PLAIN)} />)
    expect((await screen.findByTestId('gmail-send-summary')).textContent).toBe('to Dana, ops@acme.com, lead@acme.com, bcc: archive@elsewhere.io')
    const envelope = screen.getByTestId('gmail-send-envelope').textContent
    for (const row of ['reply-to:replies@elsewhere.io', 'subject:Q3 renewal — quote', 'thread:t1', 'in-reply-to:<m1@acme.com>', 'x-acme-ticket:4417']) expect(envelope).toContain(row)
    expect(screen.getByTestId('gmail-send-body').textContent).toBe('Hi Dana,\nPricing holds through Nov 15.')
    expect(screen.queryByTestId('gmail-send-cut')).toBeNull()
    expect(screen.queryByTestId('gmail-send-attachments')).toBeNull()
  })

  it('shows the start of a body the card cut short, and says the rest is not shown', async () => {
    render(<gmailSendLook.Look requestBody={cardBody(`${PLAIN}${'More pricing detail. '.repeat(3000)}`)} />)
    expect((await screen.findByTestId('gmail-send-body')).textContent).toMatch(/^Hi Dana,\nPricing holds through Nov 15.\nMore pricing detail/)
    expect(screen.getByTestId('gmail-send-summary').textContent).toContain('bcc: archive@elsewhere.io')
    expect(screen.getByTestId('gmail-send-cut').textContent).toBe('The rest of the email is not shown.')
  })

  it('draws an HTML body in a frame that runs no scripts, loads nothing, and cannot be refreshed into another page', async () => {
    const html = PLAIN.replace('text/plain', 'text/html').replace(/\n\nHi Dana[\s\S]*$/, '\n\n<META http-equiv="refresh" content="0;url=https://phish.example/login"><p>Hi <b>Dana</b></p><script>window.ran = true</script><img src="https://pixel.example/p.gif">\n')
    render(<gmailSendLook.Look requestBody={cardBody(html)} />)
    const frame = await screen.findByTestId('email-html')
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(frame.className).toContain('pointer-events-none')
    const srcdoc = frame.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toMatch(/^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;/)
    expect(srcdoc).not.toMatch(/<meta http-equiv="refresh"/i)
    expect(srcdoc).toContain('<x-meta http-equiv="refresh"')
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

  it('lists every web address the HTML names, and says the email has attachments it does not show', async () => {
    const mime = `From: Jeremy <jeremy@example.com>
To: dana@acme.com
Subject: Invoice
Content-Type: multipart/mixed; boundary=m

--m
Content-Type: text/html

<META http-equiv="refresh" content="0;url=https://phish.example/login"><img src="https://pixel.example/p.gif?u=1&amp;v=2"><a href="https://x.example">x</a>.
--m
Content-Type: application/pdf
Content-Disposition: attachment; filename=quote.pdf

pdf
--m--
`
    render(<gmailSendLook.Look requestBody={cardBody(mime)} />)
    const list = await screen.findByTestId('email-web-addresses')
    expect([...list.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['https://phish.example/login', 'https://pixel.example/p.gif?u=1&v=2', 'https://x.example'])
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

  it('leaves a call no look matches to the raw request and its endpoint title', () => {
    expect(requestLookFor('gmail', 'POST', 'gmail/v1/users/me/drafts/send')).toBeUndefined()
  })
})
