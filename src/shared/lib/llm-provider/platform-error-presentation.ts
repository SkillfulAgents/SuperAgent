import {
  extractErrorMessage,
  inferErrorStatus,
  type ProviderErrorPresentation,
} from './error-presentation'

const ORG_BILLING_LINK = '/dashboard/organizations/{orgId}?tab=billing'

export const PAYWALL_COMPONENT = 'paywall'

function isSpendCap(status: number | undefined, raw: string): boolean {
  if (!/spend cap/i.test(raw)) return false
  return status === 429 || /\b429\b/.test(raw)
}

// Streaming 402s often drop the JSON body and surface as "socket closed".
// Any 402 from this provider is a billing deny; the card picks the CTA.
function isInsufficientBalance(status: number | undefined, raw: string): boolean {
  const lower = raw.toLowerCase()
  return (
    status === 402
    || /\b402\b/.test(lower)
    || lower.includes('insufficient balance')
    || lower.includes('insufficient_balance')
  )
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

// Balanced-brace scan: survives prose after the JSON blob, which a greedy
// first-{ to last-} regex would not.
function parseFirstJsonObject(raw: string): unknown {
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

// The proxy's `subscription_required` flag, if the 402 body kept it.
export function extractSubscriptionRequired(body: unknown): boolean | undefined {
  const fromRecord = (record: Record<string, unknown>): boolean | undefined => {
    const nested = record.error
    const nestedRecord = nested && typeof nested === 'object'
      ? nested as Record<string, unknown>
      : undefined
    return (
      readBooleanField(record, 'subscription_required')
      ?? readBooleanField(record, 'subscriptionRequired')
      ?? (nestedRecord && (
        readBooleanField(nestedRecord, 'subscription_required')
        ?? readBooleanField(nestedRecord, 'subscriptionRequired')
      ))
    )
  }

  if (body && typeof body === 'object') return fromRecord(body as Record<string, unknown>)
  if (typeof body !== 'string') return undefined

  const parsed = parseFirstJsonObject(body)
  if (parsed && typeof parsed === 'object') {
    return fromRecord(parsed as Record<string, unknown>)
  }
  return undefined
}

function spendCapSentence(raw: string): string {
  const idx = raw.search(/A spend cap/i)
  const sentence = idx >= 0 ? raw.slice(idx) : raw
  return sentence.replace(/\s*Ask a workspace admin to raise it\.?/i, '').trim()
    || 'A spend cap for this workspace was reached.'
}

// Invitational copy, not an error: the leading **bold** is the card title.
function paywallMessage(subscriptionRequired: boolean | undefined): string {
  if (subscriptionRequired === true) {
    return '**Subscribe to keep going** An active subscription lets your agents pick this back up.'
  }
  if (subscriptionRequired === false) {
    return '**You need more usage credit to continue** Add usage credit to your account to resume this answer.'
  }
  return '**You need more usage credit to continue** Subscribe or top up to resume this answer.'
}

// Null = not a platform-specific error class; the base provider applies the
// generic banner.
export function parsePlatformErrorResponse(
  status: number | undefined,
  body: unknown,
): ProviderErrorPresentation | null {
  const raw = extractErrorMessage(body)
  const inferred = status ?? inferErrorStatus(raw)

  if (isSpendCap(inferred, raw)) {
    return {
      severity: 'warning',
      message: `**Spend Limit Reached:** ${spendCapSentence(raw)} [Raise spend limit in the admin dashboard](${ORG_BILLING_LINK})`,
      icon: 'circle-dollar-sign',
    }
  }

  if (isInsufficientBalance(inferred, raw)) {
    return {
      severity: 'error',
      icon: 'info',
      message: paywallMessage(extractSubscriptionRequired(body)),
      component: PAYWALL_COMPONENT,
      placement: 'composer',
    }
  }

  return null
}
