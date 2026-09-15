// Shopify only allows Gamut's app to be installed from its App Store listing
// (App Store rule 2.3.1). Shopify then opens Platform's /install/shopify, which
// deeplinks back with ?toolkit_slug=shopify&shop=<store>, and only then does
// the normal Composio connect run for that store.
export const SHOPIFY_APP_INSTALL_URL = 'https://apps.shopify.com/gamut'

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

export function parseShopDomain(value: unknown): string | null {
  return typeof value === 'string' && SHOP_DOMAIN.test(value) ? value : null
}

// New public apps may only call the GraphQL Admin API (App Store rule 2.2.4).
const GRAPHQL_ADMIN_PATH = /^\/admin\/api\/[a-z0-9-]+\/graphql\.json$/

export function isShopifyGraphqlPath(path: string): boolean {
  return GRAPHQL_ADMIN_PATH.test(path)
}
