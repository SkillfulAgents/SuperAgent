import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import {
  DownloadNonceIdentitySchema,
  DownloadNonceRedeemResponseSchema,
  type DownloadNonceIdentity,
} from '@shared/lib/services/download-nonce-schema'
import {
  getPlatformAuthStatus,
  savePlatformAuth,
  type PlatformAuthStatus,
} from '@shared/lib/services/platform-auth-service'
import {
  getOrCreatePlatformClientInstanceId,
  getPlatformDeviceName,
} from '@shared/lib/services/platform-device-service'
import { isAuthMode } from '@shared/lib/auth/mode'

const execFileAsync = promisify(execFile)
const EXEC_TIMEOUT_MS = 5_000
// hdiutil's plist grows with every mounted image; keep headroom.
const EXEC_MAX_BUFFER = 4 * 1024 * 1024
const RESOLVE_TIMEOUT_MS = 5_000

// A download nonce arrives out-of-band with the installer (filename, download
// URL metadata) and is only ever an upgrade hint: every failure below degrades
// to "no offer" and the normal onboarding flow.
const NONCE_PATTERN = /[a-f0-9]{40,64}/
const FILENAME_NONCE_RE = /(?:^|[-_ ])([a-f0-9]{40,64})(?=$|[-_ .()])/i
// The terminator is simply "next char isn't hex": inside xattr binary-plist
// bytes the URL run is followed by an arbitrary object-marker byte, not a
// URL delimiter.
const URL_NONCE_RE = /[?&]dl=([a-f0-9]{40,64})(?![a-f0-9])/i
const WHERE_FROMS_ATTR = 'com.apple.metadata:kMDItemWhereFroms'

export interface DownloadNonceRecoveryConfig {
  /** Absolute path of the installed .app bundle (macOS xattr channel). */
  macBundlePath?: string
  /** File the Windows installer drops containing the installer's filename. */
  windowsHandoffFile?: string
  /**
   * Dev/test-only extra probe: a path whose xattrs and filename are scanned
   * exactly like the real channels. Callers must gate this on non-packaged
   * builds.
   */
  testSourcePath?: string
  /** Skip spawning hdiutil (non-macOS or tests). */
  disableMountScan?: boolean
}

export function extractNonceFromFileName(fileName: string): string | null {
  const base = path.basename(fileName)
  const match = FILENAME_NONCE_RE.exec(base)
  return match ? match[1].toLowerCase() : null
}

export function extractNonceFromUrlText(text: string): string | null {
  const match = URL_NONCE_RE.exec(text)
  return match ? match[1].toLowerCase() : null
}

/**
 * `xattr -p com.apple.metadata:kMDItemWhereFroms` prints the value as hex
 * bytes of a binary plist. URLs are stored as plain UTF-8 runs inside it, so
 * decoding the bytes and scanning for the `dl` query param is sufficient —
 * no plist parser needed.
 */
export function extractNonceFromWhereFromsHex(hexOutput: string): string | null {
  const hex = hexOutput.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length < 2) return null
  try {
    const decoded = Buffer.from(hex, 'hex').toString('latin1')
    return extractNonceFromUrlText(decoded)
  } catch {
    return null
  }
}

/**
 * Scans `hdiutil info -plist` output for mounted disk images whose backing
 * file is a stamped installer DMG. Restricted to images that look like ours
 * so an unrelated mounted DMG can't inject a candidate.
 */
export function extractNonceFromHdiutilPlist(plistXml: string): string | null {
  const stringValues = plistXml.match(/<string>([^<]*)<\/string>/g) ?? []
  for (const tag of stringValues) {
    const value = tag.slice('<string>'.length, -'</string>'.length)
    if (!value.toLowerCase().endsWith('.dmg')) continue
    const base = path.basename(value)
    if (!/gamut|superagent/i.test(base)) continue
    const nonce = extractNonceFromFileName(base)
    if (nonce) return nonce
  }
  return null
}

async function readWhereFromsNonce(targetPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'xattr',
      ['-p', WHERE_FROMS_ATTR, targetPath],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
    )
    return extractNonceFromWhereFromsHex(stdout)
  } catch {
    // Attribute missing (xattr exits non-zero) or tool unavailable.
    return null
  }
}

async function readMountedDmgNonce(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('hdiutil', ['info', '-plist'], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    })
    return extractNonceFromHdiutilPlist(stdout)
  } catch {
    return null
  }
}

/** One-shot read: the handoff file is deleted after the first look. */
async function readWindowsHandoffNonce(handoffFile: string): Promise<string | null> {
  let content: string
  try {
    content = await fs.readFile(handoffFile, 'utf8')
  } catch {
    return null
  }
  await fs.rm(handoffFile, { force: true }).catch(() => {})
  return extractNonceFromFileName(content.trim())
}

/** Derives the installed .app bundle root from the running executable path. */
export function deriveMacBundlePath(execPath: string): string | null {
  const match = /^(.*?\.app)\/Contents\/MacOS\//.exec(execPath)
  return match ? match[1] : null
}

let config: DownloadNonceRecoveryConfig = {}
let scanPromise: Promise<string | null> | undefined
// undefined = not attempted; null = terminally no offer (missing nonce,
// resolve 404, dismissed, or redeemed). A transient resolve failure leaves
// this undefined so a later status query retries.
let cachedOffer: { code: string; identity: DownloadNonceIdentity } | null | undefined

export function configureDownloadNonceRecovery(next: DownloadNonceRecoveryConfig): void {
  config = next
}

/** Test hook: clears all cached recovery/resolve state. */
export function resetDownloadNonceStateForTests(): void {
  config = {}
  scanPromise = undefined
  cachedOffer = undefined
}

async function scanForNonce(): Promise<string | null> {
  if (config.windowsHandoffFile) {
    const fromHandoff = await readWindowsHandoffNonce(config.windowsHandoffFile)
    if (fromHandoff) return fromHandoff
  }

  if (process.platform === 'darwin') {
    const bundlePath = config.macBundlePath ?? deriveMacBundlePath(process.execPath)
    if (bundlePath) {
      const fromXattr = await readWhereFromsNonce(bundlePath)
      if (fromXattr) return fromXattr
    }
    if (!config.disableMountScan) {
      const fromMount = await readMountedDmgNonce()
      if (fromMount) return fromMount
    }
  }

  if (config.testSourcePath) {
    const fromTestXattr = await readWhereFromsNonce(config.testSourcePath)
    if (fromTestXattr) return fromTestXattr
    const fromTestName = extractNonceFromFileName(config.testSourcePath)
    if (fromTestName && NONCE_PATTERN.test(fromTestName)) return fromTestName
  }

  return null
}

function recoverNonceOnce(): Promise<string | null> {
  if (!scanPromise) {
    scanPromise = scanForNonce().catch(() => null)
  }
  return scanPromise
}

async function postDownloadNonce(pathName: string, body: unknown): Promise<Response | null> {
  const base = getPlatformBaseUrl()
  if (!base) return null
  try {
    return await fetch(new URL(pathName, base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    })
  } catch {
    return null
  }
}

export interface DownloadNonceOffer {
  available: boolean
  email?: string
  orgName?: string
}

/**
 * Returns the "Continue as X" offer for the onboarding screen, running the
 * one-time channel scan and a non-consuming platform resolve on first call.
 */
export async function getDownloadNonceOffer(): Promise<DownloadNonceOffer> {
  if (isAuthMode() || getPlatformAuthStatus().connected) return { available: false }
  if (cachedOffer !== undefined) {
    return cachedOffer
      ? { available: true, email: cachedOffer.identity.email, orgName: cachedOffer.identity.org_name }
      : { available: false }
  }

  const code = await recoverNonceOnce()
  if (!code) {
    cachedOffer = null
    return { available: false }
  }

  const res = await postDownloadNonce('/api/download-nonce/resolve', { code })
  if (!res) return { available: false } // transient: leave undefined for retry
  if (!res.ok) {
    cachedOffer = null
    return { available: false }
  }

  const parsed = DownloadNonceIdentitySchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) {
    cachedOffer = null
    return { available: false }
  }

  cachedOffer = { code, identity: parsed.data }
  return { available: true, email: parsed.data.email, orgName: parsed.data.org_name }
}

export function dismissDownloadNonceOffer(): void {
  cachedOffer = null
}

/**
 * Redeems the recovered nonce (single-use on the platform) and completes the
 * connection through the same persistence path as the interactive flow.
 */
export async function redeemDownloadNonce(userId: string): Promise<PlatformAuthStatus> {
  const offer = cachedOffer
  if (!offer) {
    throw new DownloadNonceUnavailableError()
  }

  const res = await postDownloadNonce('/api/download-nonce/redeem', {
    code: offer.code,
    client_instance_id: getOrCreatePlatformClientInstanceId(),
    device_name: getPlatformDeviceName(),
  })
  if (!res) {
    throw new Error('Could not reach the platform. Check your connection and try again.')
  }
  if (!res.ok) {
    // The nonce is spent or expired; the offer is gone either way.
    cachedOffer = null
    throw new DownloadNonceUnavailableError()
  }

  const payload = DownloadNonceRedeemResponseSchema.parse(await res.json())
  const status = await savePlatformAuth(userId, {
    token: payload.token,
    email: payload.email || null,
    label: payload.label || null,
    orgId: payload.org_id || null,
    orgName: payload.org_name || null,
    role: payload.role || null,
    userId: payload.user_id || null,
    memberId: payload.member_id || null,
  })
  cachedOffer = null
  return status
}

export class DownloadNonceUnavailableError extends Error {
  constructor() {
    super('This sign-in link has expired. Use the regular login instead.')
    this.name = 'DownloadNonceUnavailableError'
  }
}
