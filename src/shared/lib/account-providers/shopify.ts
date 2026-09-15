import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { connectedAccounts } from '@shared/lib/db/schema'
import { ownerScope } from '@shared/lib/auth/ownership'
import { composioFetch, getOrCreateAuthConfig } from '@shared/lib/composio/client'
import type { ProviderServerAdapter } from './server-adapters'
import { ConnectionStoreSchema, CreateConnectionResponseSchema } from './shopify-schema'

// Shopify keeps one refresh token per app and store, so a second grant for a
// store breaks the first. A Shopify account is therefore named after its store,
// and every connect for a store reuses that store's account. The token itself
// never reaches the host: Platform redacts it and enforces GraphQL-only calls.

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

function parseShopDomain(value: unknown): string | null {
  return typeof value === 'string' && SHOP_DOMAIN.test(value) ? value : null
}

/** The caller's account for a store. */
async function findStoreAccount(c: Context, store: string) {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(and(
      eq(connectedAccounts.toolkitSlug, 'shopify'),
      eq(connectedAccounts.displayName, store),
      ownerScope(c, connectedAccounts.userId),
    ))
    .limit(1)
  return account
}

export const shopifyAdapter: ProviderServerAdapter = {
  // A connect arrives from an install (Platform's /install/shopify hands the store
  // to Connections) or reconnects an account named after its store. Composio's
  // link page would ask the merchant to type the store, which App Store review
  // forbids; only `POST /connected_accounts` takes it pre-filled and sends the
  // merchant straight to Shopify.
  async startConnect({ c, identity, reconnecting, callbackUrl, userId }) {
    const store = parseShopDomain(reconnecting ? reconnecting.displayName : identity)
    if (!store) return { error: 'Install Gamut from the Shopify App Store to connect a store', status: 400 }
    if (!reconnecting && (await findStoreAccount(c, store))?.status === 'active') {
      return { error: `${store} is already connected`, status: 409 }
    }
    const authConfig = await getOrCreateAuthConfig('shopify')
    const raw = await composioFetch<unknown>('/connected_accounts', {
      method: 'POST',
      body: JSON.stringify({
        auth_config: { id: authConfig.id },
        connection: {
          ...(userId ? { user_id: userId } : {}),
          callback_url: callbackUrl,
          state: { authScheme: 'OAUTH2', val: { status: 'INITIALIZING', subdomain: store.replace(/\.myshopify\.com$/, '') } },
        },
      }),
    })
    const created = CreateConnectionResponseSchema.parse(raw)
    return { connectionId: created.id, redirectUrl: created.redirect_url }
  },

  // The store Composio authorized names the account, and that store's account is
  // the one updated (a lapsed one included), whichever account the connect
  // started from.
  async afterConnect({ c, connectionId }) {
    const connection = await composioFetch<unknown>(`/connected_accounts/${encodeURIComponent(connectionId)}`)
      .then((raw) => ConnectionStoreSchema.parse(raw))
      .catch(() => null)
    // Another toolkit's subdomain (a Zendesk tenant) is not a store. Shopify
    // hosts are case-insensitive; the reported subdomain may not be.
    const subdomain = connection?.toolkit?.slug === 'shopify' ? connection.state?.val?.subdomain : undefined
    const store = subdomain ? parseShopDomain(`${subdomain.toLowerCase()}.myshopify.com`) : null
    if (!store) return { error: "Couldn't confirm which Shopify store was connected. Try connecting again." }
    return { displayName: store, reconnectAccountId: (await findStoreAccount(c, store))?.id }
  },

  // A reconnect's new grant replaces its store's account in afterConnect;
  // importing it first would duplicate the store.
  syncImports: false,
}
