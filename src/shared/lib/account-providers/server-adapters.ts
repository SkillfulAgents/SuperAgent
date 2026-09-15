import type { Context } from 'hono'
import type { ConnectedAccount } from '@shared/lib/db/schema'
import { shopifyAdapter } from './shopify'

/**
 * Server-side behavior a provider needs beyond the generic connect path.
 * Generic routes call these hooks and never check a provider's slug.
 */
export interface ProviderServerAdapter {
  /**
   * Starts the grant in place of the account provider: refuse it, or return the
   * connection and where to send the user. `identity` is what the renderer sent
   * with the connect.
   */
  startConnect?(ctx: {
    c: Context
    identity: unknown
    reconnecting?: ConnectedAccount
    callbackUrl: string
    userId?: string
  }): Promise<{ error: string; status: 400 | 409 } | { connectionId: string; redirectUrl: string }>
  /**
   * After a grant finishes: the name to save it under, and the account it
   * replaces. A provider with this hook owns its accounts: they are never
   * created directly.
   */
  afterConnect?(ctx: { c: Context; connectionId: string }):
    Promise<{ error: string } | { displayName: string; reconnectAccountId?: string }>
  /** Background sync leaves this provider's unknown grants to the connect flow. */
  syncImports?: false
}

const SERVER_ADAPTERS: Record<string, ProviderServerAdapter> = {
  shopify: shopifyAdapter,
}

export function getServerAdapter(slug: string): ProviderServerAdapter | undefined {
  return SERVER_ADAPTERS[slug]
}
