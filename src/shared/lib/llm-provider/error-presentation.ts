import { z } from 'zod'

export const providerErrorPlacementSchema = z.enum(['inline', 'composer'])

export const providerErrorPresentationSchema = z.object({
  severity: z.enum(['error', 'warning']),
  /** Markdown. Providers that need a CTA put a link in the message. */
  message: z.string(),
  /** Lucide icon name, e.g. `info`, `circle-dollar-sign`. */
  icon: z.string(),
  /** Where the renderer shows it. `inline` (default) = a row in the chat stream; `composer` = in place of the composer. */
  placement: providerErrorPlacementSchema.optional(),
  /** Renderer component-registry key. Unset or unknown = the default card. */
  component: z.string().optional(),
  /** Final CTA URL for the component, resolved by the provider. Unset = no link to offer. */
  href: z.string().optional(),
  /** The catalog model the error is about, resolved by the provider (e.g. the one a plan refused). */
  model: z.object({ id: z.string(), label: z.string() }).optional(),
  /** Plain-text notice for chat integrations. Unset = their generic message for the error code. */
  chatText: z.string().optional(),
})

export type ProviderErrorPresentation = z.infer<typeof providerErrorPresentationSchema>
export type ProviderErrorSeverity = ProviderErrorPresentation['severity']
export type ProviderErrorPlacement = z.infer<typeof providerErrorPlacementSchema>

export const DEFAULT_ERROR_PLACEMENT: ProviderErrorPlacement = 'inline'

export function errorPlacement(presentation: ProviderErrorPresentation | null | undefined): ProviderErrorPlacement {
  return presentation?.placement ?? DEFAULT_ERROR_PLACEMENT
}

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

// Balanced-brace scan: survives prose after the JSON blob, which a greedy
// first-{ to last-} regex would not.
export function parseFirstJsonObject(raw: string): unknown {
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (inString) {
        if (ch === '\\') i++
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return undefined
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
