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

function spendCapSentence(raw: string): string {
  const idx = raw.search(/A spend cap/i)
  const sentence = idx >= 0 ? raw.slice(idx) : raw
  return sentence.replace(/\s*Ask a workspace admin to raise it\.?/i, '').trim()
    || 'A spend cap for this workspace was reached.'
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
      message: `**Insufficient Balance:** Subscribe or top up to continue running agents. [Go to billing](${ORG_BILLING_LINK})`,
      icon: 'info',
    }
  }

  return null
}
