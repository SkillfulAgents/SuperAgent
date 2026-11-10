/**
 * The vault's passkeys in the agent's browser: a CDP virtual authenticator on
 * the agent's tab that holds an account's passkeys while a sign-in with it
 * runs ("present"), or keeps the one a site creates while the agent adds one
 * ("record"). Chrome then answers the page's passkey prompt itself, with no
 * dialog: the private key never passes through the agent or the page.
 *
 * What the authenticator does, probed on Chrome 156 (headless):
 * - It belongs to one tab, and survives that tab's reloads and navigations.
 * - Any DevTools session that attaches to the tab and then detaches turns it
 *   off, whoever enabled it: our own fills and captures do, agent-browser's
 *   commands do not. So it is armed again right after our connections close
 *   (login-cdp), and on a short check for anyone else's.
 * - A credential added back answers as the same credential; each use counts
 *   one up from the sign count it was given.
 *
 * The keeper holds one tab at a time, for a while (`ttlMs`), and lets go of it
 * when the time is up, the browser goes, or the host disarms it.
 */
import { CdpConnection, onCdpConnectionClosed, type CdpEvent } from './login-cdp'

/** A passkey as Chrome's WebAuthn domain gives and takes it (base64 fields). */
export interface VirtualCredential {
  credentialId: string
  rpId: string
  /** PKCS#8, base64. */
  privateKey: string
  userHandle?: string
  signCount: number
  userName?: string
  userDisplayName?: string
}

export type KeeperMode = 'present' | 'record'

export interface KeeperState {
  armed: boolean
  mode: KeeperMode | null
  targetId: string | null
  /** The credentials it holds now (ids). */
  credentialIds: string[]
  /** Credentials the page asserted since arming (ids), oldest first. */
  asserted: string[]
  expiresAt: number | null
}

interface Armed {
  targetId: string
  mode: KeeperMode
  connection: CdpConnection
  sessionId: string
  authenticatorId: string
  /** What it holds: given (present) or created on the page (record). */
  credentials: VirtualCredential[]
  /** Created on the page and not yet taken by the host. */
  created: VirtualCredential[]
  asserted: string[]
  expiresAt: number
  expiry: NodeJS.Timeout
  check: NodeJS.Timeout
  unsubscribe: () => void
}

/** What a site sees of the authenticator: a platform passkey that is backed up (it lives in the vault). */
const AUTHENTICATOR = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
  defaultBackupEligibility: true,
  defaultBackupState: true,
}

/** How often the keeper checks that no one else's session turned the authenticator off. */
const CHECK_MS = 1_000

/**
 * The sign count a passkey goes in with: the seconds since 1970, never less
 * than it had. Each use counts one up from there, so two agents, or two
 * browsers, using one passkey a second apart never send a site a count it
 * already saw, with nothing written back.
 */
export function signCountNow(stored: number, now = Date.now()): number {
  return Math.max(stored, Math.floor(now / 1000))
}

export class PasskeyKeeper {
  private armed: Armed | null = null
  /** Arming in progress: the next arm or disarm waits for it. */
  private busy: Promise<void> = Promise.resolve()
  private waiters: Array<() => void> = []

  constructor(private readonly deps: { connectBrowser: () => Promise<CdpConnection> }) {
    onCdpConnectionClosed(() => this.recheckSoon())
  }

  state(): KeeperState {
    const armed = this.armed
    return {
      armed: armed !== null,
      mode: armed?.mode ?? null,
      targetId: armed?.targetId ?? null,
      credentialIds: armed?.credentials.map((credential) => credential.credentialId) ?? [],
      asserted: [...(armed?.asserted ?? [])],
      expiresAt: armed?.expiresAt ?? null,
    }
  }

  /**
   * Hold `credentials` on the tab (present), or an empty authenticator that
   * keeps what the page creates (record), for `ttlMs`. Arming again replaces
   * what was armed, unless it is the same tab in record mode and `keep` asks
   * to go on recording there.
   */
  arm(input: { targetId: string; mode: KeeperMode; credentials?: VirtualCredential[]; ttlMs: number; keep?: boolean }): Promise<void> {
    return this.serial(async () => {
      const current = this.armed
      if (input.keep && current && current.targetId === input.targetId && current.mode === input.mode) {
        this.extend(current, input.ttlMs)
        return
      }
      this.release()
      const connection = await this.deps.connectBrowser()
      try {
        const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId: input.targetId, flatten: true })
        const credentials = (input.credentials ?? []).map((credential) => ({ ...credential, signCount: signCountNow(credential.signCount) }))
        const authenticatorId = await this.enable(connection, sessionId, credentials)
        const armed: Armed = {
          targetId: input.targetId,
          mode: input.mode,
          connection,
          sessionId,
          authenticatorId,
          credentials,
          created: [],
          asserted: [],
          expiresAt: Date.now() + input.ttlMs,
          expiry: setTimeout(() => this.disarm(), input.ttlMs),
          check: setInterval(() => void this.recheck(), CHECK_MS),
          unsubscribe: connection.onEvent((event) => this.onEvent(event)),
        }
        armed.expiry.unref()
        armed.check.unref()
        this.armed = armed
      } catch (error) {
        connection.close()
        throw error
      }
    })
  }

  /** Let go of the tab: its authenticator, and the passkeys in it, go with the session. */
  disarm(): Promise<void> {
    return this.serial(async () => this.release())
  }

  /**
   * A passkey the page created since arming (record mode), once there is one
   * or after `waitMs`; taken, so the host gets each once.
   */
  async takeCreated(waitMs: number): Promise<VirtualCredential | null> {
    const deadline = Date.now() + waitMs
    for (;;) {
      const created = this.armed?.created.shift()
      if (created) return created
      const left = deadline - Date.now()
      if (left <= 0 || !this.armed || this.armed.mode !== 'record') return null
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(left, 5_000))
        function done() { clearTimeout(timer); resolve() }
        this.waiters.push(done)
      })
    }
  }

  private extend(armed: Armed, ttlMs: number): void {
    clearTimeout(armed.expiry)
    armed.expiresAt = Date.now() + ttlMs
    armed.expiry = setTimeout(() => this.disarm(), ttlMs)
    armed.expiry.unref()
  }

  private async enable(connection: CdpConnection, sessionId: string, credentials: VirtualCredential[]): Promise<string> {
    await connection.send('WebAuthn.enable', { enableUI: false }, sessionId)
    const { authenticatorId } = await connection.send<{ authenticatorId: string }>('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR }, sessionId)
    for (const credential of credentials) {
      await connection.send('WebAuthn.addCredential', {
        authenticatorId,
        credential: { ...credential, isResidentCredential: true, backupEligibility: true, backupState: true },
      }, sessionId)
    }
    return authenticatorId
  }

  private onEvent(event: CdpEvent): void {
    const armed = this.armed
    if (!armed) return
    // On the browser's own session: ours is named in it.
    if (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === armed.sessionId) {
      // The tab closed, or the browser went: nothing is left to hold.
      this.release()
      return
    }
    if (event.sessionId !== armed.sessionId) return
    if (event.method === 'WebAuthn.credentialAdded' && armed.mode === 'record') {
      const credential = toVirtual(event.params?.credential)
      if (!credential) return
      armed.credentials.push(credential)
      armed.created.push(credential)
      for (const wake of this.waiters.splice(0)) wake()
    } else if (event.method === 'WebAuthn.credentialAsserted') {
      const id = event.params?.credential?.credentialId
      if (typeof id === 'string') armed.asserted.push(id)
    }
  }

  /** Someone's session left the tab: check soon (theirs detaches a moment after the close). */
  private recheckSoon(): void {
    if (!this.armed) return
    setTimeout(() => void this.recheck(), 100).unref()
  }

  /** Arm again if another session's leaving turned the authenticator off, with what it held. */
  private recheck(): Promise<void> {
    return this.serial(async () => {
      const armed = this.armed
      if (!armed) return
      try {
        await armed.connection.send('WebAuthn.getCredentials', { authenticatorId: armed.authenticatorId }, armed.sessionId)
        return
      } catch {
        // Turned off ("not enabled for this session"), or the tab is gone.
      }
      try {
        armed.authenticatorId = await this.enable(armed.connection, armed.sessionId, armed.credentials)
      } catch (error) {
        console.error('[PasskeyKeeper] Arming the tab again failed:', error instanceof Error ? error.message : 'Unknown error')
        this.release()
      }
    })
  }

  private release(): void {
    const armed = this.armed
    if (!armed) return
    this.armed = null
    clearTimeout(armed.expiry)
    clearInterval(armed.check)
    armed.unsubscribe()
    // Our session leaving the tab turns its authenticator off with the passkeys in it.
    armed.connection.close()
    for (const wake of this.waiters.splice(0)) wake()
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.busy.then(work, work)
    this.busy = next.catch(() => {})
    return next
  }
}

/** A credential from a WebAuthn event, or null when it is not a whole one. */
function toVirtual(value: unknown): VirtualCredential | null {
  if (!value || typeof value !== 'object') return null
  const credential = value as Record<string, unknown>
  if (typeof credential.credentialId !== 'string' || typeof credential.rpId !== 'string' || typeof credential.privateKey !== 'string') return null
  return {
    credentialId: credential.credentialId,
    rpId: credential.rpId,
    privateKey: credential.privateKey,
    ...(typeof credential.userHandle === 'string' ? { userHandle: credential.userHandle } : {}),
    signCount: typeof credential.signCount === 'number' ? credential.signCount : 0,
    ...(typeof credential.userName === 'string' ? { userName: credential.userName } : {}),
    ...(typeof credential.userDisplayName === 'string' ? { userDisplayName: credential.userDisplayName } : {}),
  }
}
