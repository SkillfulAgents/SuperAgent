import { z } from 'zod'

export const providerErrorPresentationSchema = z.object({
  severity: z.enum(['error', 'warning']),
  /** Markdown. Providers that need a CTA put a link in the message. */
  message: z.string(),
  /** Lucide icon name, e.g. `info`, `circle-dollar-sign`. */
  icon: z.string(),
})

export type ProviderErrorPresentation = z.infer<typeof providerErrorPresentationSchema>
export type ProviderErrorSeverity = ProviderErrorPresentation['severity']

export function extractErrorMessage(body: unknown): string {
  if (typeof body === 'string') {
    const jsonMatch = body.match(/\{"type":\s*"error".*?"message":\s*"([^"]+)"\s*\}/)
    if (jsonMatch) {
      const prefix = body.slice(0, body.indexOf('{')).trim()
      const msg = jsonMatch[1]
      return prefix ? `${prefix} ${msg}` : msg
    }
    return body
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const nested = record.error
    if (nested && typeof nested === 'object') {
      const message = (nested as Record<string, unknown>).message
      if (typeof message === 'string' && message.trim()) return message
    }
    if (typeof record.message === 'string' && record.message.trim()) return record.message
    if (typeof record.error === 'string' && record.error.trim()) return record.error
  }
  return body == null ? '' : String(body)
}

export function inferErrorStatus(raw: string): number | undefined {
  const paren = raw.match(/\((\d{3})\)/)
  if (paren) return Number(paren[1])
  const bare = raw.match(/\b(401|402|403|429|500|502|503)\b/)
  if (bare) return Number(bare[1])
  return undefined
}

export function defaultParseErrorResponse(
  _status: number | undefined,
  body: unknown,
): ProviderErrorPresentation {
  return {
    severity: 'error',
    message: `**LLM Provider Error:** ${extractErrorMessage(body)}`,
    icon: 'info',
  }
}

const ORG_PLACEHOLDER_LINK = /\[([^\]]+)\]\(([^)]*\{orgId\}[^)]*)\)/g

export function resolvePresentationMarkdown(
  markdown: string,
  org: { connected?: boolean; platformBaseUrl?: string | null; orgId?: string | null } | null | undefined,
): string {
  if (!markdown.includes('{orgId}')) return markdown
  if (!org?.connected || !org.orgId || !org.platformBaseUrl) {
    return markdown.replace(ORG_PLACEHOLDER_LINK, '$1')
  }
  const origin = org.platformBaseUrl.replace(/\/$/, '')
  const orgId = org.orgId
  return markdown.replace(ORG_PLACEHOLDER_LINK, (_match, label: string, href: string) => {
    const path = href.replaceAll('{orgId}', orgId)
    const url = /^https?:\/\//i.test(path) ? path : `${origin}${path}`
    return `[${label}](${url})`
  })
}
