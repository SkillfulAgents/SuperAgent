import type { ApiTarget } from '@shared/lib/api-target'
import type { CloudDashboardSession } from '@shared/lib/cloud-dashboard-session-schema'
import { mintDeploymentSessionForDashboard } from '@shared/lib/services/cloud-workspace-service'
import { readCloudWorkspaceRecord, setCloudWorkspaceRecordClearedListener } from '@shared/lib/platform-auth/cloud-workspace-record'
import {
  clearCloudDashboardCookie,
  hasCloudDashboardCookie,
  plantCloudDashboardCookie,
} from './cloud-dashboard-cookie'

function normalizeOrigin(url: string): string {
  return url.replace(/\/+$/, '')
}

// Plant and clear share one queue so a leftover plant cannot restore a
// disconnected account. The epoch bumps the instant the record is cleared,
// before the queued clear runs, so an in-flight mint can still see the switch.
let jarOp: Promise<void> = Promise.resolve()
let jarEpoch = 0

async function withCookieJar<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void
  const previous = jarOp
  jarOp = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

function recordMatches(origin: string): boolean {
  const record = readCloudWorkspaceRecord()
  return Boolean(record?.deploymentUrl && normalizeOrigin(record.deploymentUrl) === origin)
}

export async function ensureCloudDashboardSession(
  target: ApiTarget,
): Promise<CloudDashboardSession> {
  if (target !== 'cloud') return { useCloudOrigin: false, origin: null }

  // Stamp before waiting in line. A waiter that snapshots after a disconnect
  // would inherit the new generation and could accept the previous account's
  // cookie when the next record reuses the same origin.
  const started = jarEpoch
  return withCookieJar(async () => {
    if (started !== jarEpoch) return { useCloudOrigin: false, origin: null }

    const record = readCloudWorkspaceRecord()
    const origin = record?.deploymentUrl ? normalizeOrigin(record.deploymentUrl) : null
    if (!origin) return { useCloudOrigin: false, origin: null }

    if (await hasCloudDashboardCookie(origin)) {
      if (started !== jarEpoch || !recordMatches(origin)) {
        return { useCloudOrigin: false, origin: null }
      }
      return { useCloudOrigin: true, origin }
    }

    const minted = await mintDeploymentSessionForDashboard()
    if (!minted || started !== jarEpoch) {
      return { useCloudOrigin: false, origin }
    }

    const plantedOrigin = normalizeOrigin(minted.deploymentUrl)
    if (!recordMatches(plantedOrigin)) {
      return { useCloudOrigin: false, origin }
    }

    await plantCloudDashboardCookie(plantedOrigin, minted.setCookies)
    if (started !== jarEpoch || !recordMatches(plantedOrigin)) {
      await clearCloudDashboardCookie(plantedOrigin)
      return { useCloudOrigin: false, origin: null }
    }

    const planted = await hasCloudDashboardCookie(plantedOrigin)
    if (started !== jarEpoch || !recordMatches(plantedOrigin)) {
      await clearCloudDashboardCookie(plantedOrigin)
      return { useCloudOrigin: false, origin: null }
    }
    return {
      useCloudOrigin: planted,
      origin: planted ? plantedOrigin : origin,
    }
  })
}

export function registerCloudDashboardCookieCleanup(): void {
  setCloudWorkspaceRecordClearedListener((deploymentUrl) => {
    jarEpoch += 1
    void withCookieJar(() => clearCloudDashboardCookie(normalizeOrigin(deploymentUrl)))
  })
}
