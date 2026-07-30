/**
 * vCard for an agent, so iMessage users can save it as a real phone contact
 * instead of a bare number. Server-side only — `resolveAgentWebUrl` reads
 * settings, so this must never be imported by the renderer.
 */

import { readCloudWorkspaceRecord } from '@shared/lib/platform-auth/cloud-workspace-record'
import { GAMUT_CONTACT_PHOTO_JPEG_BASE64 } from './gamut-contact-photo'

/** The single Gamut iMessage line every agent is reached on. */
const GAMUT_PHONE_E164 = '+12053967934'
const GAMUT_MARKETING_URL = 'https://gamut.so'

export interface AgentContactCardInput {
  slug: string
  name: string
  description?: string
  /** https URL for this agent, or null when the install has no public URL. */
  appUrl: string | null
}

/** vCard 3.0 TEXT-value escaping (RFC 2426 §2). An unescaped comma truncates the field. */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Fold a content line at 75 octets with CRLF + one leading space (RFC 2425 §5.8.1).
 * The spec states the limit in characters; octets are stricter for UTF-8, so this
 * satisfies both. Never splits a multi-byte sequence.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line

  const chunks: string[] = []
  let offset = 0
  let limit = 75
  while (offset < bytes.length) {
    let take = Math.min(limit, bytes.length - offset)
    while (take > 1 && offset + take < bytes.length && (bytes[offset + take] & 0xc0) === 0x80) {
      take--
    }
    chunks.push(bytes.subarray(offset, offset + take).toString('utf8'))
    offset += take
    limit = 74 // continuation lines lose one octet to the leading space
  }
  return chunks.join('\r\n ')
}

export function buildAgentContactCard({ slug, name, description, appUrl }: AgentContactCardInput): Buffer {
  // The label carries the honesty: the fallback goes to a marketing page, so it
  // must not claim to open this agent.
  const linkUrl = appUrl ?? GAMUT_MARKETING_URL
  const linkLabel = appUrl ? 'Open in Gamut' : 'Gamut'

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//Gamut//Contact Card//EN',
    `UID:gamut-agent-${slug}`,
    `N:;${escapeValue(name)};;;`,
    `FN:${escapeValue(name)}`,
    // A constant, and deliberate disclosure: the card must not read as a person.
    'TITLE:AI Agent',
    'ORG:Gamut',
    `TEL;type=IPHONE;type=pref:${GAMUT_PHONE_E164}`,
    `item1.URL:${linkUrl}`,
    `item1.X-ABLabel:${linkLabel}`,
    `PHOTO;ENCODING=b;TYPE=JPEG:${GAMUT_CONTACT_PHOTO_JPEG_BASE64}`,
    ...(description ? [`NOTE:${escapeValue(description)}`] : []),
    'END:VCARD',
  ]

  return Buffer.from(lines.map(foldLine).join('\r\n') + '\r\n', 'utf8')
}

/**
 * https URL where this agent can be opened, or null when the install has none.
 *
 * Deliberately never falls back to the `superagent://` desktop scheme that
 * `resolveAppLinkContext` returns: this card lives on a phone, where nothing has
 * registered that scheme, so the row would render tappable and then fail.
 *
 * Env and settings are read at call time — main-process env is assigned after
 * this module is imported.
 */
export function resolveAgentWebUrl(agentSlug: string): string | null {
  // `||`, not `??`: an empty value must fall back too, or the link degrades to a
  // scheme-less dead row.
  const base =
    process.env.HOST_PUBLIC_URL?.trim().replace(/\/+$/, '')
    || readCloudWorkspaceRecord()?.deploymentUrl?.trim().replace(/\/+$/, '')
  if (!base) return null
  return `${base}/agents/${encodeURIComponent(agentSlug)}`
}
