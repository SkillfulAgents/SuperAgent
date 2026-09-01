import {
  extractErrorMessage,
  inferErrorStatus,
  type ProviderErrorPresentation,
} from './error-presentation'

const ORG_BILLING_LINK = '/dashboard/organizations/{orgId}?tab=billing'

function isSpendCap(status: number | undefined, raw: string): boolean {
  if (!/spend cap/i.test(raw)) return false
  return status === 429 || /\b429\b/.test(raw)
}

function isInsufficientBalance(status: number | undefined, raw: string): boolean {
  const lower = raw.toLowerCase()
  return (
    lower.includes('insufficient balance')
    || lower.includes('insufficient_balance')
    || ((status === 402 || lower.includes('402')) && lower.includes('top up'))
  )
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

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

  const jsonMatch = body.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return undefined
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0])
    if (parsed && typeof parsed === 'object') {
      return fromRecord(parsed as Record<string, unknown>)
    }
  } catch {
    return undefined
  }
  return undefined
}

function spendCapSentence(raw: string): string {
  const idx = raw.search(/A spend cap/i)
  const sentence = idx >= 0 ? raw.slice(idx) : raw
  return sentence.replace(/\s*Ask a workspace admin to raise it\.?/i, '').trim()
    || 'A spend cap for this workspace was reached.'
}

function insufficientBalancePresentation(
  subscriptionRequired: boolean | undefined,
): ProviderErrorPresentation {
  if (subscriptionRequired === true) {
    return {
      severity: 'error',
      icon: 'info',
      message: '**Subscription Required:** Subscribe to continue running agents.',
      paywall: { subscriptionRequired: true },
    }
  }
  if (subscriptionRequired === false) {
    return {
      severity: 'error',
      icon: 'info',
      message: '**Insufficient Balance:** This workspace is out of credits.',
      paywall: { subscriptionRequired: false },
    }
  }
  return {
    severity: 'error',
    icon: 'info',
    message: `**Insufficient Balance:** Subscribe or top up to continue running agents. [Go to billing](${ORG_BILLING_LINK})`,
  }
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
    return insufficientBalancePresentation(extractSubscriptionRequired(body))
  }

  return null
}
