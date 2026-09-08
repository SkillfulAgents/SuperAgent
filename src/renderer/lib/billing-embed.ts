export type BillingEmbedView = 'topup' | 'subscribe' | 'payment'

export function platformOriginFromBaseUrl(platformBaseUrl: string | null | undefined): string | null {
  if (!platformBaseUrl) return null
  try {
    const url = new URL(platformBaseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

export function buildBillingEmbedUrl(
  platformBaseUrl: string | null | undefined,
  orgId: string,
  options: { view?: BillingEmbedView; intent?: 'topup'; parent: string; surface?: 'cta'; cta?: 'add_card' },
): string | null {
  const origin = platformOriginFromBaseUrl(platformBaseUrl)
  if (!origin) return null
  const url = new URL(`/embed/billing/${encodeURIComponent(orgId)}`, origin)
  url.searchParams.set('parent', options.parent)
  if (options.view) url.searchParams.set('view', options.view)
  if (options.intent) url.searchParams.set('intent', options.intent)
  if (options.surface) url.searchParams.set('surface', options.surface)
  if (options.cta) url.searchParams.set('cta', options.cta)
  return url.toString()
}
