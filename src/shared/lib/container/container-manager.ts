import { createContainerClient } from './client-factory'
import type { ContainerClient, ContainerConfig } from './types'
import { db } from '@shared/lib/db'
import { agentConnectedAccounts, connectedAccounts } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getOrCreateProxyToken } from '@shared/lib/proxy/token-store'
import { getContainerHostUrl, getAppPort } from '@shared/lib/proxy/host-url'
import { getSettings } from '@shared/lib/config/settings'
import { getAgentWorkspaceDir } from '@shared/lib/config/data-dir'
import { copyChromeProfileData } from '@shared/lib/browser/chrome-profile'
import { messagePersister } from './message-persister'

// Singleton to manage all container clients
class ContainerManager {
  private clients: Map<string, ContainerClient> = new Map()

  // Get or create a container client for an agent
  getClient(agentId: string): ContainerClient {
    let client = this.clients.get(agentId)

    if (!client) {
      const config: ContainerConfig = {
        agentId,
      }

      client = createContainerClient(config)
      this.clients.set(agentId, client)
    }

    return client
  }

  // Ensure container is running, starting it with connected accounts if needed
  // Returns the container client
  //
  // Note: User secrets are now stored in .env file in the workspace,
  // not passed as env vars. Only connected account tokens are injected.
  //
  // Parameter is agentId for backwards compatibility, but will be slug after migration
  async ensureRunning(agentId: string): Promise<ContainerClient> {
    const client = this.getClient(agentId)
    const info = await client.getInfo()

    if (info.status !== 'running') {
      // Pass proxy config and account metadata (no raw tokens)
      const envVars: Record<string, string> = {}

      // Set up proxy authentication
      const proxyToken = await getOrCreateProxyToken(agentId)
      const hostUrl = getContainerHostUrl()
      const appPort = getAppPort()
      envVars['PROXY_BASE_URL'] = `http://${hostUrl}:${appPort}/api/proxy/${agentId}`
      envVars['PROXY_TOKEN'] = proxyToken

      // Fetch connected accounts for this agent
      const accountMappings = await db
        .select({
          account: connectedAccounts,
        })
        .from(agentConnectedAccounts)
        .innerJoin(
          connectedAccounts,
          eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
        )
        .where(eq(agentConnectedAccounts.agentSlug, agentId))

      // Build account metadata (names + IDs, no tokens)
      const accountMetadata: Record<string, Array<{ name: string; id: string }>> = {}
      for (const { account } of accountMappings) {
        if (account.status !== 'active') continue
        if (!accountMetadata[account.toolkitSlug]) {
          accountMetadata[account.toolkitSlug] = []
        }
        accountMetadata[account.toolkitSlug].push({
          name: account.displayName,
          id: account.id,
        })
      }
      envVars['CONNECTED_ACCOUNTS'] = JSON.stringify(accountMetadata)

      // Pass host browser env vars if enabled
      const settings = getSettings()
      if (settings.app?.useHostBrowser) {
        envVars['AGENT_BROWSER_USE_HOST'] = '1'
        envVars['HOST_APP_URL'] = `http://${hostUrl}:${appPort}`
      }

      // Copy Chrome profile data into workspace if configured
      const chromeProfileId = settings.app?.chromeProfileId
      if (chromeProfileId) {
        const workspaceDir = getAgentWorkspaceDir(agentId)
        const browserProfileDir = `${workspaceDir}/.browser-profile`
        if (copyChromeProfileData(chromeProfileId, browserProfileDir)) {
          console.log(`[ContainerManager] Copied Chrome profile "${chromeProfileId}" to workspace`)
        }
      }

      // Start container (user secrets are in .env file in workspace)
      await client.start({ envVars })

      // Broadcast agent status change globally
      messagePersister.broadcastGlobal({
        type: 'agent_status_changed',
        agentSlug: agentId,
        status: 'running',
      })
    }

    return client
  }

  // Remove a client from the cache
  removeClient(agentId: string): void {
    this.clients.delete(agentId)
  }

  // Stop all containers
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.clients.entries()).map(
      async ([agentId, client]) => {
        try {
          await client.stop()
        } catch (error) {
          console.error(`Failed to stop container for agent ${agentId}:`, error)
        }
      }
    )
    await Promise.all(stopPromises)
    this.clients.clear()
  }

  // Synchronous stop - used for exit handlers where async isn't available
  stopAllSync(): void {
    for (const [agentId, client] of this.clients.entries()) {
      try {
        client.stopSync()
      } catch (error) {
        console.error(`Failed to stop container for agent ${agentId} (sync):`, error)
      }
    }
    this.clients.clear()
  }

  // Check if any agents have running containers
  async hasRunningAgents(): Promise<boolean> {
    for (const client of this.clients.values()) {
      const info = await client.getInfo()
      if (info.status === 'running') {
        return true
      }
    }
    return false
  }

  // Get list of running agent IDs
  async getRunningAgentIds(): Promise<string[]> {
    const running: string[] = []
    for (const [agentId, client] of this.clients.entries()) {
      const info = await client.getInfo()
      if (info.status === 'running') {
        running.push(agentId)
      }
    }
    return running
  }
}

// Export singleton instance
// Use globalThis to persist across hot reloads in development
const globalForManager = globalThis as unknown as {
  containerManager: ContainerManager | undefined
}

export const containerManager =
  globalForManager.containerManager ?? new ContainerManager()

if (process.env.NODE_ENV !== 'production') {
  globalForManager.containerManager = containerManager
}

// Note: Graceful shutdown handlers are registered in the application entry point
// (src/main/index.ts for Electron, src/web/server.ts for web)
// This avoids side effects at module import time and allows proper cleanup coordination
