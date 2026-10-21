/**
 * Gamut NG spike: the host app as a Worker + one Durable Object per org.
 * The Worker serves the built UI as static assets and sends /api/* to the
 * org's host DO, which runs the same Hono app the desktop and web builds use.
 */
import { DurableObject } from 'cloudflare:workers'
import { Container, ContainerProxy } from '@cloudflare/containers'

// Required by @cloudflare/containers for outboundByHost interception.
export { ContainerProxy }
import type { AnyD1Database } from 'drizzle-orm/d1'
import app from '../../src/api/index'
import { openDatabase } from '../../src/shared/lib/db/open-database'
import { d1 } from '../../src/shared/lib/db/drivers/d1'
import { validateAuthModeStartup } from '../../src/shared/lib/auth/startup-validation'
import { ensureManagedPlatformConnection } from '../../src/shared/lib/llm-provider/connection-settings'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '../../src/shared/lib/config/data-dir'
import { clearSettingsCache } from '../../src/shared/lib/config/settings'
import { CONTAINER_INTERNAL_PORT } from '../../src/shared/lib/container/base-container-client'
import { containerHost } from '../../src/shared/lib/agent-actor'
import { refreshRunnerAvailability } from '../../src/shared/lib/container/client-factory'
import { decodeOrgIdFromToken, installPlatformFetchInterceptor } from '../../src/shared/lib/platform-attribution'
import { getPlatformAccessToken } from '../../src/shared/lib/services/platform-auth-service'
import { setAgentContainerNamespace, type AgentContainerNamespace } from '../../src/shared/lib/container/cloudflare-container-runtime'

interface Env {
  DB: AnyD1Database
  HOST_DO: DurableObjectNamespace<HostDO>
  AGENT_CONTAINER: DurableObjectNamespace<AgentContainer>
  ASSETS: Fetcher
  APP_ORIGIN: string
}

export class HostDO extends DurableObject<Env> {
  private ready: Promise<unknown> | undefined

  async fetch(request: Request): Promise<Response> {
    this.ready ??= this.boot().catch((error) => {
      this.ready = undefined
      throw error
    })
    await this.ready
    return app.fetch(request)
  }

  // The part of startup.ts a request-driven host needs: database, auth mode
  // checks (verifies PLATFORM_TOKEN), and the managed platform model connection.
  private async boot(): Promise<void> {
    setAgentContainerNamespace(this.env.AGENT_CONTAINER as unknown as AgentContainerNamespace)
    seedSettings(this.env.APP_ORIGIN)
    await openDatabase({ driver: d1(this.env.DB) })
    await validateAuthModeStartup()
    // Platform calls carry the acting member (as startup.ts does for an org token).
    const platformToken = getPlatformAccessToken()
    if (platformToken && decodeOrgIdFromToken(platformToken) !== null) installPlatformFetchInterceptor()
    await ensureManagedPlatformConnection()
    // The runner list is computed at import, before the binding above existed.
    await refreshRunnerAvailability()
    await containerHost.ensureImageReady()
  }
}

// Same seed gamut-controller-ecs writes on an org's first boot (seedSettingsJson):
// platform providers, wizard skipped, OIDC-only login.
function seedSettings(origin: string): void {
  const path = join(getDataDir(), 'settings.json')
  if (existsSync(path)) return
  mkdirSync(getDataDir(), { recursive: true })
  writeFileSync(path, JSON.stringify({
    llmProvider: 'platform',
    voice: { sttProvider: 'platform' },
    app: { hostBrowserProvider: 'platform', setupCompleted: true },
    shareAnalytics: true,
    shareErrorReports: true,
    auth: {
      requireAdminApproval: false,
      allowLocalAuth: false,
      allowSocialAuth: true,
      trustedOrigins: [origin],
      sessionMaxLifetimeHrs: 168,
      sessionIdleTimeoutMin: 1440,
    },
    container: { containerRunner: 'cloudflare-container' },
  }))
  clearSettingsCache()
}

function hostFor(env: Env) {
  return env.HOST_DO.get(env.HOST_DO.idFromName('local-org'))
}

/** One agent's container. The host drives it through the runtime in cloudflare-container-runtime.ts. */
export class AgentContainer extends Container<Env> {
  defaultPort = CONTAINER_INTERNAL_PORT
  sleepAfter = '30m'
  enableInternet = true

  static {
    // The agent calls the host at http://host.internal (proxy, host tools, bootstrap).
    this.outboundByHost = { 'host.internal': (request: Request, env: Env) => hostFor(env).fetch(request) }
  }

  async startAgent(envVars: Record<string, string>): Promise<void> {
    await this.startAndWaitForPorts({ ports: CONTAINER_INTERNAL_PORT, startOptions: { envVars } })
  }

  async stopAgent(): Promise<void> {
    await this.stop()
  }

  async agentRunning(): Promise<boolean> {
    const { status } = await this.getState()
    return status === 'running' || status === 'healthy'
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) return hostFor(env).fetch(request)
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
