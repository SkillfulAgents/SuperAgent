import { ChevronDown } from 'lucide-react'
import PostalMime, { type Email } from 'postal-mime'
import { PersonAvatar } from '@renderer/components/agent-integrations/messages/message-parts'
import { ClampedBody, EmailHtml, WebAddresses, webAddresses, withImages } from './email-html'
import type { CustomPreview } from './custom-previews'

/** A Gmail send as far as the card's copy of the request shows it. */
export interface GmailSend {
  /** Absent when the message names no sender: Gmail sends as the account. */
  from?: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string
  date?: string
  /** Every other header the message sets, and the thread it joins. */
  details: { label: string; value: string }[]
  /** The HTML part, drawn in a frame that runs no scripts and loads nothing, with the inline images the card has. */
  html?: string
  /** The plain part, drawn when there is no HTML. */
  text: string
  /** Every web address the HTML names. */
  webAddresses: string[]
  /** The email carries attachments, which the card does not show. */
  attachments: boolean
  /** The card's copy of the request ends before the email does. */
  cut: boolean
}

/** Headers the card shows in their own place, or that only frame the MIME structure. */
const SHOWN_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'mime-version', 'content-type', 'content-transfer-encoding'])

/**
 * The message's `raw` and `threadId`, from the card's copy of the request body. A copy cut short is read only when the raw runs
 * to the cut and no key before it sets raw too, so no other raw can hide past the cut or under an escaped key name.
 * A draft carries its message under `message`.
 */
function sentMessage(requestBody: string, draft: boolean): { raw: string; threadId?: string; cut: boolean } | undefined {
  const fields = (json: unknown) => (json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : undefined)
  const messageOf = (json: unknown) => (draft ? fields(fields(json)?.message) : fields(json))
  const threadIdOf = (json: Record<string, unknown>) => (typeof json.threadId === 'string' ? { threadId: json.threadId } : {})
  let whole: Record<string, unknown> | undefined
  try {
    whole = messageOf(JSON.parse(requestBody))
  } catch {
    const match = /"raw":\s*"([A-Za-z0-9+/_-]+=*)…?$/.exec(requestBody)
    if (!match) return undefined
    const prefix = requestBody.slice(0, match.index)
    // As with raw, an earlier or escaped message key could be the one Gmail reads.
    if (draft && (/\\u/i.test(prefix) || prefix.match(/"message"\s*:/g)?.length !== 1)) return undefined
    // The cut raw's object takes this key, so a draft's raw counts only when that object is the message. Random, so a body cannot plant it.
    const end = crypto.randomUUID()
    let head: Record<string, unknown> | undefined
    try {
      head = messageOf(JSON.parse(`${prefix}"${end}":0}${draft ? '}' : ''}`))
    } catch {
      return undefined
    }
    return head && Object.hasOwn(head, end) && !Object.hasOwn(head, 'raw') ? { raw: match[1], ...threadIdOf(head), cut: true } : undefined
  }
  return whole && typeof whole.raw === 'string' ? { raw: whole.raw, ...threadIdOf(whole), cut: false } : undefined
}

/**
 * The email in a Gmail send, read from the request body the card shows, which may be cut short. Undefined when
 * the headers do not all fit, or a recipient could hide from the card.
 */
export async function readGmailSend(requestBody: string, draft = false): Promise<GmailSend | undefined> {
  const message = sentMessage(requestBody, draft)
  if (!message) return undefined
  const { cut, threadId: thread } = message
  const base64 = message.raw.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  // A copy cut short can end inside a group of four characters, which does not decode. A whole raw decodes unpadded.
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- the custom preview treats a rejection as none
  const bytes = Uint8Array.from(atob(cut ? base64.slice(0, base64.length - (base64.length % 4)) : base64), (char) => char.charCodeAt(0))
  // A recipient header past the cut would be missing from the card.
  if (cut && !/\r?\n\r?\n/.test(new TextDecoder('latin1').decode(bytes))) return undefined
  const email = await PostalMime.parse(bytes)
  const keys = email.headers.map((header) => header.key)
  if (keys.some((key) => key.startsWith('resent-'))) return undefined
  // A repeated address header, or one postal-mime could not read, would hide a recipient.
  const read = (header: string, value: Email['from'] | Email['to']): string[] | undefined => {
    const count = keys.filter((key) => key === header).length
    const parsed = value === undefined ? [] : Array.isArray(value) ? value : [value]
    const flat = parsed.flatMap((address) => address.group ?? [address])
    const boxes = flat.flatMap(({ name, address }) => (address ? [name ? `${name} <${address}>` : address] : []))
    return count > 1 || (count === 1 && parsed.length === 0) || boxes.length < flat.length ? undefined : boxes
  }
  const from = read('from', email.from)
  const to = read('to', email.to)
  const cc = read('cc', email.cc)
  const bcc = read('bcc', email.bcc)
  const replyTo = read('reply-to', email.replyTo)
  if (!from || !to || !cc || !bcc || !replyTo) return undefined
  // The last part of a cut email may itself be cut, so only parts before it draw.
  const whole = cut ? email.attachments.slice(0, -1) : email.attachments
  // Senders often label an image application/octet-stream.
  const images = new Map(whole.flatMap((part) => {
    const contentId = part.contentId?.replace(/^<|>$/g, '')
    return contentId && typeof part.content !== 'string' && /^(image\/[\w.+-]+|application\/octet-stream)$/.test(part.mimeType)
      ? [[contentId, dataUrl(part.mimeType, new Uint8Array(part.content))] as const]
      : []
  }))
  return {
    ...(from[0] ? { from: from[0] } : {}),
    to,
    cc,
    bcc,
    replyTo,
    subject: email.subject ?? '',
    ...(email.date && !Number.isNaN(Date.parse(email.date)) ? { date: email.date } : {}),
    details: [
      ...(thread ? [{ label: 'thread', value: thread }] : []),
      ...email.headers.filter(({ key }) => !SHOWN_HEADERS.has(key)).map(({ key, value }) => ({ label: key, value })),
    ],
    ...(email.html ? { html: withImages(email.html, images) } : {}),
    text: (email.text ?? '').trim(),
    webAddresses: email.html ? webAddresses(email.html) : [],
    attachments: /^multipart\/mixed/i.test(email.headers.find(({ key }) => key === 'content-type')?.value ?? '') || email.attachments.some((part) => part.disposition === 'attachment'),
    cut,
  }
}

function dataUrl(type: string, bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${type};base64,${btoa(binary)}`
}

function senderParts(from = ''): { name: string; address?: string } {
  const match = from.match(/^(.*\S)\s*<([^<>]+)>$/)
  return match ? { name: match[1], address: match[2] } : { name: from }
}

/**
 * An address as Gmail's summary line shows it: the name, or the whole address when there is none. Never "me", since the From
 * the agent wrote need not be the account's, and never a name that reads as an address, since it can name a different one.
 */
function shortAddress(value: string): string {
  const { name, address = value } = senderParts(value)
  return name && name !== address && !/[@＠﹫]/.test(name) ? name : address
}

const GMAIL_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }

/** Gmail's envelope: the summary line, and the details box its arrow opens in place. */
function GmailEnvelope({ email }: { email: GmailSend }) {
  const short = (values: string[]) => values.map(shortAddress).join(', ')
  const summary = [
    email.to.length + email.cc.length > 0 ? `to ${short([...email.to, ...email.cc])}` : '',
    email.bcc.length > 0 ? `bcc: ${short(email.bcc)}` : '',
  ].filter(Boolean).join(', ')
  const details = [
    ['from', email.from || 'The connected account'],
    ['reply-to', email.replyTo.join(', ')],
    ['to', email.to.join(', ')],
    ['cc', email.cc.join(', ')],
    ['bcc', email.bcc.join(', ')],
    ['date', email.date ? new Date(email.date).toLocaleString(undefined, GMAIL_DATE) : ''],
    ['subject', email.subject],
    ...email.details.map(({ label, value }) => [label, value]),
  ].filter(([, value]) => value)
  return (
    <details data-testid="gmail-send-envelope">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
        <span className="break-words" data-testid="gmail-send-summary">{summary || 'to no recipients'}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </summary>
      <dl className="mt-1 grid w-fit min-w-72 max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border border-[#dadce0] bg-white px-5 py-4 text-[13px] shadow-md dark:border-[#5f6368] dark:bg-[#2d2e30]">
        {details.map(([label, value], index) => (
          <div key={index} className="contents">
            <dt className="text-right text-[#5f6368] dark:text-[#9aa0a6]">{label}:</dt>
            <dd className="break-words text-[#1f1f1f] dark:text-[#e3e3e3]">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

export function GmailSendView({ email }: { email: GmailSend }) {
  const { name, address } = senderParts(email.from)
  return (
    <article
      aria-label="Email preview"
      data-testid="gmail-send"
      className="mt-3 rounded-md border border-[#e0e0e0] bg-white px-4 py-3 font-[Roboto,Arial,sans-serif] text-[#1f1f1f] dark:border-[#3c4043] dark:bg-[#1f1f1f] dark:text-[#e3e3e3]"
    >
      <h3 className="break-words text-[22px] leading-snug">{email.subject || '(no subject)'}</h3>
      <div className="mt-3 flex items-start gap-3">
        {/* Gmail draws one initial. */}
        <PersonAvatar person={{ name: (name || address || '?').charAt(0) }} size={40} className="rounded-full" />
        <div className="min-w-0 flex-1 text-[13px] leading-5">
          {email.from ? (
            <div className="break-words">
              <span className="text-sm font-semibold">{name}</span>
              {address && <span className="text-xs text-[#5f6368] dark:text-[#9aa0a6]"> &lt;{address}&gt;</span>}
            </div>
          ) : <div className="font-semibold">The connected account</div>}
          <div className="text-[#5f6368] dark:text-[#9aa0a6]"><GmailEnvelope email={email} /></div>
        </div>
      </div>
      <div className="mt-3 text-sm leading-relaxed sm:pl-[52px]">
        <ClampedBody>
          {email.html
            ? <EmailHtml html={email.html} />
            : <div className="whitespace-pre-wrap break-words" data-testid="gmail-send-body">{email.text}</div>}
        </ClampedBody>
      </div>
      <div className="sm:pl-[52px]"><WebAddresses addresses={email.webAddresses} /></div>
      {email.attachments && <p className="mt-2 text-xs text-[#5f6368] sm:pl-[52px] dark:text-[#9aa0a6]" data-testid="gmail-send-attachments">Has attachments, not shown.</p>}
      {email.cut && <p className="mt-2 text-xs text-[#5f6368] sm:pl-[52px] dark:text-[#9aa0a6]" data-testid="gmail-send-cut">The rest of the email is not shown.</p>}
    </article>
  )
}

function gmailCustomPreview(method: string, path: RegExp, title: string, draft: boolean): CustomPreview {
  return {
    toolkit: 'gmail',
    method,
    path,
    title,
    read: async (requestBody) => {
      const email = await readGmailSend(requestBody, draft)
      return email ? <GmailSendView email={email} /> : undefined
    },
  }
}

export const gmailSendCustomPreview = gmailCustomPreview('POST', /^gmail\/v1\/users\/[^/]+\/messages\/send$/, 'Allow sending this email from Gmail?', false)
export const gmailDraftCreateCustomPreview = gmailCustomPreview('POST', /^gmail\/v1\/users\/[^/]+\/drafts$/, 'Allow saving this draft in Gmail?', true)
export const gmailDraftUpdateCustomPreview = gmailCustomPreview('PUT', /^gmail\/v1\/users\/[^/]+\/drafts\/[^/]+$/, 'Allow changing this draft in Gmail?', true)
