import { z } from 'zod'

import { BILLING_RESUME_SYSTEM_PROMPT } from '@shared/lib/llm-provider/paywall-cta'
import type { TransformedItem } from '@shared/lib/utils/message-transform'

export const resumeAfterBillingBodySchema = z.object({
  attemptId: z.string().uuid(),
})

export function latestVisibleAssistantHasPaywall(items: TransformedItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || item.type !== 'assistant') continue
    return Boolean(item.errorPresentation?.paywall)
  }
  return false
}

export function latestHiddenContinuationIsResume(items: TransformedItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || item.type !== 'user') continue
    const text = item.content.text
    if (text.startsWith('[SYSTEM] ')) {
      return text === BILLING_RESUME_SYSTEM_PROMPT
    }
    return false
  }
  return false
}
