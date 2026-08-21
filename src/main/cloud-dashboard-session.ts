import { session } from 'electron'
import type { ApiTarget } from '@shared/lib/api-target'
import { mintDeploymentSessionForDashboard } from '@shared/lib/services/cloud-workspace-service'
import { readCloudWorkspaceRecord, setCloudWorkspaceRecordClearedListener } from '@shared/lib/platform-auth/cloud-workspace-record'

export type CloudDashboardSession = {
  useCloudOrigin: boolean
  origin: string | null
}

const SESSION_COOKIE_RE = /(?:^|;)(?:__Secure-)?better-auth\.session_token$/

export function sessionCookieNameForOrigin(origin: string): string {
  return origin.startsWith('https:') ? '__Secure-better-auth.session_token' : 'better-auth.session_token'
}

function cookieUrl(origin: string): string {
  return origin.replace(/\/+$/, '') + '/'
}

function normalizeOrigin(url: string): string {
  return url.replace(/\/+$/, '')
}

type ParsedCookie = {
  name: string
  value: string
  httpOnly: boolean
  secure: boolean
  sameSiteNone: boolean
  path: string
  maxAgeSec: number | null
}

export function parseSessionSetCookie(line: string): ParsedCookie | null {
  const parts = line.split(';').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const [nameValue, ...attrs] = parts
  const eq = nameValue.indexOf('=')
  if (eq <= 0) return null
  const name = nameValue.slice(0, eq)
  const value = nameValue.slice(eq + 1)
  if (!SESSION_COOKIE_RE.test(name) || !value) return null

  let httpOnly = false
  let secure = false
  let sameSiteNone = false
  let path = '/'
  let maxAgeSec: number | null = null
  for (const attr of attrs) {
    const [rawKey, ...rest] = attr.split('=')
    const key = rawKey.trim().toLowerCase()
    const val = rest.join('=').trim()
    if (key === 'httponly') httpOnly = true
    else if (key === 'secure') secure = true
    else if (key === 'samesite' && val.toLowerCase() === 'none') sameSiteNone = true
    else if (key === 'path') path = val || '/'
    else if (key === 'max-age') {
      const n = Number(val)
      if (Number.isFinite(n) && n > 0) maxAgeSec = Math.floor(n)
    }
  }
  return { name, value, httpOnly, secure, sameSiteNone, path, maxAgeSec }
}

export async function hasCloudDashboardCookie(origin: string): Promise<boolean> {
  const url = cookieUrl(origin)
  const name = sessionCookieNameForOrigin(origin)
  const found = await session.defaultSession.cookies.get({ url, name })
  return found.some((c) => c.name === name && Boolean(c.value))
}

export async function plantCloudDashboardCookie(
  origin: string,
  setCookieLines: string[],
): Promise<boolean> {
  const url = cookieUrl(origin)
  for (const line of setCookieLines) {
    const parsed = parseSessionSetCookie(line)
    if (!parsed) continue
    if (!parsed.httpOnly || !parsed.secure || !parsed.sameSiteNone || parsed.path !== '/') {
      continue
    }
    if (parsed.maxAgeSec == null) continue
    await session.defaultSession.cookies.set({
      url,
      name: parsed.name,
      value: parsed.value,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'no_restriction',
      expirationDate: Date.now() / 1000 + parsed.maxAgeSec,
    })
    return true
  }
  return false
}

export async function clearCloudDashboardCookie(origin: string): Promise<void> {
  const url = cookieUrl(origin)
  const name = sessionCookieNameForOrigin(origin)
  await session.defaultSession.cookies.remove(url, name)
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
