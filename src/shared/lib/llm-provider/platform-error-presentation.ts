import {
  extractErrorMessage,
  inferErrorStatus,
  parseFirstJsonObject,
  type ProviderErrorPresentation,
} from './error-presentation'
import { PLATFORM_CATALOG } from './builtin-catalogs'
import { parseModelNotInPlan, resolvePlanModel } from './platform-plan-policy'

// Registry key for the platform-billing-aware paywall card. Platform-only: the card
// reads the platform billing snapshot, so other providers must register their own key.
export const PLATFORM_PAYWALL_COMPONENT = 'platform-paywall'
// Registry key for the 403 model_not_in_plan card (upgrade, or continue on an allowed model).
export const PLATFORM_MODEL_NOT_IN_PLAN_COMPONENT = 'platform-model-not-in-plan'

// Dashboard billing page for the connected org; null without org context.
export function orgBillingUrl(
  platformBaseUrl: string | null | undefined,
  orgId: string | null | undefined,
): string | null {
  if (!platformBaseUrl || !orgId) return null
  return `${platformBaseUrl.replace(/\/+$/, '')}/dashboard/organizations/${orgId}?tab=billing`
}

function markdownLink(label: string, url: string | null): string {
  return url ? `[${label}](${url})` : label
}

function isSpendCap(status: number | undefined, raw: string): boolean {
  if (!/spend cap/i.test(raw)) return false
  return status === 429 || /\b429\b/.test(raw)
}

// Any 402 from this provider is a billing deny; the card picks the CTA. `status` is the
// declared or inferred one, so a bare "402" elsewhere in the text must not count.
function isInsufficientBalance(status: number | undefined, raw: string): boolean {
  const lower = raw.toLowerCase()
  return status === 402 || lower.includes('insufficient balance') || lower.includes('insufficient_balance')
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
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

// Copy for the plan's refusal; the card component renders its own, this is the
// markdown every other surface (and an older client) falls back to.
export function modelNotInPlanMessage(label: string | null): string {
  return `**${label ?? 'This model'} isn't included in your plan** Upgrade your workspace's plan to use it, or continue with a model your plan includes.`
}

// The same refusal as a chat integration says it.
export function modelNotInPlanChatText(label: string | null): string {
  return `⚠️ ${label ?? 'This model'} isn't included in your workspace's plan. Upgrade the plan, or pick another model for this integration.`
}

// Null = not a platform-specific error class; the base provider applies the
// generic banner. `billingUrl` is the org's resolved billing page, or null without org context.
export function parsePlatformErrorResponse(
  status: number | undefined,
  body: unknown,
  billingUrl: string | null,
): ProviderErrorPresentation | null {
  // The plan excludes this model (403). Keyed on the error type, not the status:
  // history rows carry no status, and a 403 here is never a credential problem.
  const notInPlan = parseModelNotInPlan(body)
  if (notInPlan) {
    // Resolved to the catalog here, so the card matches it by id and names it by label.
    const model = notInPlan.model ? resolvePlanModel(notInPlan.model, PLATFORM_CATALOG) : null
    return {
      severity: 'warning',
      icon: 'lock',
      message: modelNotInPlanMessage(model?.label ?? null),
      chatText: modelNotInPlanChatText(model?.label ?? null),
      component: PLATFORM_MODEL_NOT_IN_PLAN_COMPONENT,
      placement: 'composer',
      ...(model && { model }),
      ...(billingUrl && { href: billingUrl }),
    }
  }

  const raw = extractErrorMessage(body)
  const inferred = status ?? inferErrorStatus(raw)

  if (isSpendCap(inferred, raw)) {
    return {
      severity: 'warning',
      message: `**Spend Limit Reached:** ${spendCapSentence(raw)} ${markdownLink('Raise spend limit in the admin dashboard', billingUrl)}`,
      icon: 'circle-dollar-sign',
    }
  }

  if (isInsufficientBalance(inferred, raw)) {
    return {
      severity: 'error',
      icon: 'info',
      message: paywallMessage(extractSubscriptionRequired(body)),
      component: PLATFORM_PAYWALL_COMPONENT,
      placement: 'composer',
      ...(billingUrl && { href: billingUrl }),
    }
  }

  return null
}
