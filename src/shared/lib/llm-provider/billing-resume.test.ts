import { describe, expect, it } from 'vitest'

import { BILLING_RESUME_SYSTEM_PROMPT } from './paywall-cta'
import {
  latestHiddenContinuationIsResume,
  latestVisibleAssistantHasPaywall,
  resumeAfterBillingBodySchema,
} from './billing-resume'
import type { TransformedItem } from '@shared/lib/utils/message-transform'

function assistant(text: string, paywall = false): TransformedItem {
  return {
    id: 'asst-1',
    type: 'assistant',
    content: { text },
    toolCalls: [],
    createdAt: new Date(),
    apiError: 'unknown',
    errorPresentation: paywall
      ? { severity: 'error', icon: 'info', message: text, paywall: {} }
      : undefined,
  }
}

function user(text: string): TransformedItem {
  return {
    id: 'user-1',
    type: 'user',
    content: { text },
    toolCalls: [],
    createdAt: new Date(),
  }
}

describe('resumeAfterBillingBodySchema', () => {
  it('requires a uuid attempt id', () => {
    expect(resumeAfterBillingBodySchema.safeParse({}).success).toBe(false)
    expect(resumeAfterBillingBodySchema.safeParse({ attemptId: 'not-a-uuid' }).success).toBe(false)
    expect(resumeAfterBillingBodySchema.safeParse({
      attemptId: '550e8400-e29b-41d4-a716-446655440000',
    }).success).toBe(true)
  })
})

describe('latestVisibleAssistantHasPaywall', () => {
  it('trusts only a platform-authored paywall on the newest assistant', () => {
    expect(latestVisibleAssistantHasPaywall([
      user('hello'),
      assistant('API Error: 402 Workspace has insufficient balance.', false),
    ])).toBe(false)
    expect(latestVisibleAssistantHasPaywall([
      user('hello'),
      assistant('API Error: 402 Workspace has insufficient balance.', true),
    ])).toBe(true)
  })
})

describe('latestHiddenContinuationIsResume', () => {
  it('detects the hidden continuation as the newest user turn', () => {
    expect(latestHiddenContinuationIsResume([
      assistant('blocked', true),
      user(BILLING_RESUME_SYSTEM_PROMPT),
    ])).toBe(true)
    expect(latestHiddenContinuationIsResume([
      assistant('blocked', true),
      user('please keep going'),
    ])).toBe(false)
  })
})
