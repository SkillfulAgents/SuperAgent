import { db } from '@shared/lib/db'
import { connectedAccounts } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getRegisteredProviders } from '@shared/lib/account-providers'
import type { ProviderConnectionListItem } from '@shared/lib/account-providers'
import type { BaseAccountProvider } from '@shared/lib/account-providers'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import { getAccountProviderUserId } from '@shared/lib/config/settings'

type LocalStatus = 'active' | 'revoked' | 'expired'

function mapRemoteStatusToLocal(remoteStatus: ProviderConnectionListItem['status']): LocalStatus | null {
  switch (remoteStatus) {
    case 'ACTIVE': return 'active'
    case 'EXPIRED': return 'expired'
    case 'FAILED':
    case 'INACTIVE': return 'revoked'
    case 'INITIATED':
    case 'INITIALIZING': return null
  }
}

class AccountSyncService {
  private intervalId: NodeJS.Timeout | null = null
  private startupTimeoutId: NodeJS.Timeout | null = null
  private isRunning = false
  private isProcessing = false
  private pollIntervalMs = 5 * 60 * 1000
  private startupDelayMs = 10_000

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[AccountSync] Already running')
      return
    }

    this.isRunning = true
    console.log('[AccountSync] Starting service...')

    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null
      this.syncAll().catch((error) => {
        console.error('[AccountSync] Error in initial sync:', error)
      })

      this.intervalId = setInterval(() => {
        this.syncAll().catch((error) => {
          console.error('[AccountSync] Error in sync cycle:', error)
        })
      }, this.pollIntervalMs)
    }, this.startupDelayMs)

    console.log(
      `[AccountSync] Service started, first run in ${this.startupDelayMs / 1000}s, then every ${this.pollIntervalMs / 60000}m`
    )
  }

  stop(): void {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId)
      this.startupTimeoutId = null
    }
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.isRunning = false
    console.log('[AccountSync] Service stopped')
  }

  async syncAll(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const providers = getRegisteredProviders()
      for (const provider of providers) {
        try {
          await this.syncProvider(provider)
        } catch (error) {
          console.error(`[AccountSync] Error syncing ${provider.name}:`, error)
        }
      }
    } finally {
      this.isProcessing = false
    }
  }

  private async syncProvider(provider: BaseAccountProvider): Promise<void> {
    const userId = getAccountProviderUserId()

    let remoteConnections: ProviderConnectionListItem[]
    try {
      remoteConnections = await provider.listConnections(userId)
    } catch (error) {
      console.warn(`[AccountSync] Could not list remote connections for ${provider.name}:`, error)
      return
    }

    const localAccounts = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.providerName, provider.name))

    const remoteById = new Map(remoteConnections.map((c) => [c.id, c]))
    const localByConnectionId = new Map(localAccounts.map((a) => [a.providerConnectionId, a]))

    let updated = 0
    let added = 0
    let restored = 0

    for (const local of localAccounts) {
      const remote = remoteById.get(local.providerConnectionId)

      if (!remote) {
        if (local.status !== 'revoked') {
          await db.update(connectedAccounts)
            .set({ status: 'revoked', updatedAt: new Date() })
            .where(eq(connectedAccounts.id, local.id))
          updated++
        }
        continue
      }

      const mappedStatus = mapRemoteStatusToLocal(remote.status)
      if (!mappedStatus) continue

      if (mappedStatus !== 'active' && local.status === 'active') {
        await db.update(connectedAccounts)
          .set({ status: mappedStatus, updatedAt: new Date() })
          .where(eq(connectedAccounts.id, local.id))
        updated++
      } else if (mappedStatus === 'active' && local.status !== 'active') {
        await db.update(connectedAccounts)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(connectedAccounts.id, local.id))
        restored++
      }
    }

    for (const remote of remoteConnections) {
      if (remote.status !== 'ACTIVE') continue
      if (localByConnectionId.has(remote.id)) continue

      try {
        const serviceProvider = getProvider(remote.toolkitSlug)
        const fallbackName = serviceProvider?.displayName || remote.toolkitSlug

        let displayName = fallbackName
        try {
          displayName = await provider.getAccountDisplayName(
            remote.id,
            remote.toolkitSlug,
            fallbackName,
          )
        } catch {
          // Fall back to generic name
        }

        const createdAt = remote.createdAt ? new Date(remote.createdAt) : new Date()

        await db.insert(connectedAccounts).values({
          id: crypto.randomUUID(),
          providerConnectionId: remote.id,
          providerName: provider.name,
          toolkitSlug: remote.toolkitSlug,
          displayName,
          status: 'active',
          createdAt,
          updatedAt: new Date(),
        }).onConflictDoNothing()
        added++
      } catch (error) {
        console.warn(`[AccountSync] Failed to add remote connection ${remote.id}:`, error)
      }
    }

    if (updated > 0 || added > 0 || restored > 0) {
      console.log(`[AccountSync] ${provider.name}: ${updated} updated, ${added} added, ${restored} restored`)
    }
  }
}

const globalForSync = globalThis as unknown as { accountSyncService: AccountSyncService | undefined }
export const accountSyncService = globalForSync.accountSyncService ?? new AccountSyncService()
if (process.env.NODE_ENV !== 'production') {
  globalForSync.accountSyncService = accountSyncService
}
