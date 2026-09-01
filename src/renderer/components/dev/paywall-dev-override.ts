import { useSyncExternalStore } from 'react'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import type { PaywallCta } from '@shared/lib/llm-provider/paywall-cta'

// Session-window injection point for the paywall dev panel: the panel stores a
// forced card here and AgentActivityIndicator renders it in the exact spot a
// live provider error would occupy. Only the dev-only panel ever sets it, so in
// prod builds the override is permanently null.

export interface DevPaywallOverride {
  presentation: ProviderErrorPresentation
  cta: PaywallCta | null
  loading: boolean
}

let current: DevPaywallOverride | null = null
const listeners = new Set<() => void>()

export function setDevPaywallOverride(next: DevPaywallOverride | null): void {
  current = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDevPaywallOverride(): DevPaywallOverride | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}
