// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'

import { createAssistantMessage, createUserMessage } from '@renderer/test/factories'
import {
  latestPersistedPaywall,
  useSessionPaywall,
  type PaywallSource,
} from './use-session-paywall'

const PAYWALL_PRESENTATION = {
  severity: 'error' as const,
  icon: 'info' as const,
  message: '**Subscription Required:** Subscribe to continue.',
  paywall: { subscriptionRequired: true },
}

const billing = {
  cta: { kind: 'subscribe' as const, href: 'https://platform.example.com/billing' },
  loading: false,
  billingAccessKnown: false,
  billingAccessAllowed: false,
  billingUpdatedAt: 0,
}

vi.mock('@renderer/hooks/use-paywall-cta', () => ({
  usePaywallCta: () => billing,
}))

const SOURCE: PaywallSource = {
  message: 'API Error: 402 Workspace has insufficient balance.',
  presentation: PAYWALL_PRESENTATION,
}

function renderPaywall(live: PaywallSource | null, persisted: PaywallSource | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
  const rendered = renderHook(() => useSessionPaywall(live, persisted), { wrapper })
  return { ...rendered, invalidate }
}

describe('latestPersistedPaywall', () => {
  it('restores the paywall when the latest assistant message is a 402', () => {
    const paywall = latestPersistedPaywall([
      createUserMessage({ content: { text: 'hello' } }),
      createAssistantMessage({
        content: { text: 'API Error: 402 Workspace has insufficient balance.' },
        errorPresentation: PAYWALL_PRESENTATION,
      }),
    ])

    expect(paywall).toEqual({
      messageId: expect.any(String),
      message: 'API Error: 402 Workspace has insufficient balance.',
      presentation: PAYWALL_PRESENTATION,
    })
  })

  it('does not revive an older paywall after a later answer', () => {
    const paywall = latestPersistedPaywall([
      createAssistantMessage({
        content: { text: 'API Error: 402 Workspace has insufficient balance.' },
        errorPresentation: PAYWALL_PRESENTATION,
      }),
      createAssistantMessage({ content: { text: 'Recovered answer' } }),
    ])

    expect(paywall).toBeNull()
  })
})

describe('useSessionPaywall', () => {
  beforeEach(() => {
    billing.loading = false
    billing.billingAccessKnown = false
    billing.billingAccessAllowed = false
    billing.billingUpdatedAt = 0
  })

  it('does not let a snapshot cached before a live 402 dismiss it', () => {
    // Cached allowed verdict from a previous recovery, within staleTime.
    billing.billingAccessKnown = true
    billing.billingAccessAllowed = true
    billing.billingUpdatedAt = Date.now() - 5_000

    const { result, invalidate } = renderPaywall(SOURCE, null)

    expect(result.current.active).toBe(true)
    expect(result.current.suppressHistory).toBe(true)
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['platform-billing'] }),
    )
  })

  it('resolves a live 402 once a post-402 snapshot allows access', () => {
    billing.billingAccessKnown = true
    billing.billingAccessAllowed = true
    billing.billingUpdatedAt = Date.now() + 60_000

    const { result } = renderPaywall(SOURCE, null)

    expect(result.current.active).toBe(false)
    expect(result.current.suppressHistory).toBe(true)
  })

  it('keeps a live 402 active when the fresh snapshot still denies access', () => {
    billing.billingAccessKnown = true
    billing.billingAccessAllowed = false
    billing.billingUpdatedAt = Date.now() + 60_000

    const { result } = renderPaywall(SOURCE, null)

    expect(result.current.active).toBe(true)
  })

  it('keeps the persisted-paywall behavior unchanged when access is unknown', () => {
    // Older proxies never send `access`; a reloaded paywall must not lock the
    // composer forever, so the pre-existing fail-open path stays as-is.
    const { result, invalidate } = renderPaywall(null, SOURCE)

    expect(result.current.active).toBe(false)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('activates a persisted paywall when a fresh snapshot denies access', () => {
    billing.billingAccessKnown = true
    billing.billingAccessAllowed = false

    const { result } = renderPaywall(null, SOURCE)

    expect(result.current.active).toBe(true)
    expect(result.current.suppressHistory).toBe(true)
  })
})
