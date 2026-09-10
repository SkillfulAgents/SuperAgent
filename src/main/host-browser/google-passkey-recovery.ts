import WebSocket from 'ws'

const GRACE_MS = 2_000
const CHECK_INTERVAL_MS = 1_000
const COMMAND_TIMEOUT_MS = 5_000
const RECONNECT_MS = 5_000
const MAX_RECONNECTS = 5
const FAST_CHECKS = 60
const SLOW_CHECK_INTERVAL_MS = 15_000
const VERIFY_TIMEOUT_MS = 10_000
const CLEAR_GRACE_MS = 2_000
const ATTEMPT_WINDOW_MS = 60_000
const MAX_ATTEMPTS_PER_WINDOW = 3
// Google uses pk for passkey sign-in and sk/webauthn for a security key
// requested as the second factor after a password. Both open native WebAuthn.
const PASSKEY_PATH = '^/v3/signin/challenge/(?:pk|sk/webauthn)/?$'

export function isGooglePasskeyChallenge(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.origin === 'https://accounts.google.com' && new RegExp(PASSKEY_PATH).test(parsed.pathname)
  } catch {
    return false
  }
}

/**
 * A native WebAuthn dialog blocks CDP input, but Runtime.evaluate still works.
 * Invoke Google's own fallback handler so Google aborts its pending request.
 * Recognize passkey sign-in and post-password security-key verification.
 * Do not act on conditional WebAuthn, pre-prompt screens, or other challenges.
 * The security-key structure was verified in English, German, and Hebrew.
 * Unknown structures retain the narrowly scoped English fallback.
 */
function googlePasskeyExpression(recover: boolean): string {
  return String.raw`(() => {
  if (location.origin !== 'https://accounts.google.com' ||
      !new RegExp(${JSON.stringify(PASSKEY_PATH)}).test(location.pathname)) return 'not-applicable';

  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return !element.closest('[hidden], [aria-hidden="true"], [inert]') &&
      rect.width > 0 && rect.height > 0 &&
      style.visibility === 'visible' && style.display !== 'none';
  };
  const enabled = button => visible(button) &&
      !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true' &&
      !button.closest('[inert]');

  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').replace(/\u2019/g, "'");
  const englishProgress = text.includes("Verifying it's you") &&
    (text.includes('Complete sign-in using your passkey') ||
     text.includes('Complete sign-in using your security key'));
  let structuralProgress = false;
  let structuralButtons = [];
  const views = location.pathname.replace(/\/$/, '') === '/v3/signin/challenge/sk/webauthn'
    ? [...document.querySelectorAll('c-wiz[jscontroller="OzD1R"][data-view-id="gm7v4"]')].filter(visible) : [];
  if (views.length > 1) return 'waiting';
  if (views.length === 1) {
    const view = views[0];
    const sections = [...view.querySelectorAll('[jsname="rEuO1b"][jscontroller="qPYxq"] section[jscontroller="Tbb4sb"]')];
    const progress = sections.filter(section => !section.hasAttribute('jsname'));
    const errors = sections.filter(section => ['INM6z', 'dZbRZb'].includes(section.getAttribute('jsname')));
    // These are Google's verification/error states, not translated headings.
    // Require the complete known shape so a changed view fails closed.
    const knownShape = sections.length === 3 && progress.length === 1 && errors.length === 2 &&
      new Set(errors.map(section => section.getAttribute('jsname'))).size === 2;
    if (knownShape) {
      const progressVisible = visible(progress[0]);
      const errorVisible = errors.some(visible);
      if (!progressVisible && errorVisible) return 'cleared';
      if (progressVisible && errorVisible) return 'waiting';
      structuralProgress = progressVisible;
      structuralButtons = [...view.querySelectorAll('[jsname="DH6Rkf"][jscontroller="z0u0L"] [jsname="eBSUOb"][jscontroller="f8Gu1e"] button[jsname="LgbsSe"][type="button"]')];
    }
    if (!structuralProgress && !englishProgress) return 'waiting';
  }
  if (!structuralProgress && !englishProgress) return 'cleared';
  const buttons = [...document.querySelectorAll('button')].filter(button => enabled(button) &&
    ((structuralProgress && structuralButtons.includes(button)) ||
     (englishProgress && button.innerText.trim() === 'Try another way')));
  if (buttons.length !== 1) return 'waiting';
  if (!${recover}) return 'ready';
  buttons[0].click();
  return 'clicked';
})()`
}

export const GOOGLE_PASSKEY_RECOVERY_EXPRESSION = googlePasskeyExpression(true)
export const GOOGLE_PASSKEY_INSPECTION_EXPRESSION = googlePasskeyExpression(false)

interface TargetInfo {
  targetId: string
  type: string
  url: string
}

interface TargetState {
  url: string
  sessionId?: string
  since: number
  generation: number
  checks: number
  attempted: boolean
  attemptedAt?: number
  clearSince?: number
  verificationReported: boolean
  nextCheckAt: number
  attemptTimes: number[]
  busy: boolean
}

interface PendingCommand {
  resolve: (result: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** One observer per cloud browser; independent of the agent and the live viewer. */
class RecoveryConnection {
  private socket?: WebSocket
  private stopped = false
  private sequence = 0
  private pending = new Map<number, PendingCommand>()
  private targets = new Map<string, TargetState>()
  private interval?: ReturnType<typeof setInterval>
  private reconnect?: ReturnType<typeof setTimeout>
  private retries = 0

  constructor(readonly url: string) {
    this.connect()
  }

  get active(): boolean {
    return !this.stopped && !!(this.socket || this.reconnect)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.reconnect)
    clearInterval(this.interval)
    this.socket?.terminate()
    this.resetConnection()
    this.targets.clear()
  }

  private connect(): void {
    if (this.stopped) return
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url, { handshakeTimeout: COMMAND_TIMEOUT_MS })
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.on('error', () => {
      // Never log the socket URL or remote errors: they can contain credentials.
      socket.terminate()
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.resetConnection()
      this.scheduleReconnect()
    })
    socket.on('message', data => {
      if (this.socket !== socket) return
      try {
        const message = JSON.parse(data.toString())
        if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id)
          if (!pending) return
          this.pending.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error('Passkey recovery CDP command failed'))
          else pending.resolve(message.result ?? {})
        } else if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') {
          this.updateTarget(message.params.targetInfo)
        } else if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
          // A reload can create a new challenge without changing the URL.
          for (const [targetId, target] of this.targets) {
            if (target.sessionId === message.sessionId) {
              this.updateTarget({ targetId, type: 'page', url: message.params.frame.url }, true)
            }
          }
        } else if (message.method === 'Target.targetDestroyed') {
          this.targets.delete(message.params.targetId)
        } else if (message.method === 'Target.detachedFromTarget') {
          for (const target of this.targets.values()) {
            if (target.sessionId === message.params.sessionId) target.sessionId = undefined
          }
        }
      } catch {
        // Malformed/irrelevant CDP messages must not affect normal browsing.
      }
    })
    socket.on('open', () => {
      void this.discover(socket)
    })
  }

  private async discover(socket: WebSocket): Promise<void> {
    try {
      await this.send('Target.setDiscoverTargets', { discover: true })
      const result = await this.send('Target.getTargets')
      if (this.socket !== socket || this.stopped) return
      const infos = result.targetInfos as TargetInfo[]
      const liveIds = new Set(infos.map(info => info.targetId))
      for (const id of this.targets.keys()) {
        if (!liveIds.has(id)) this.targets.delete(id)
      }
      for (const info of infos) this.updateTarget(info)
      this.retries = 0
      this.interval = setInterval(() => {
        for (const [id, target] of this.targets) {
          if (isGooglePasskeyChallenge(target.url) && !target.busy &&
              Date.now() >= target.nextCheckAt && Date.now() - target.since >= GRACE_MS) {
            void this.check(id, target, socket)
          }
        }
      }, CHECK_INTERVAL_MS)
      this.interval.unref()
    } catch {
      socket.terminate()
    }
  }

  private updateTarget(info: TargetInfo, newDocument = false): void {
    if (info.type !== 'page') return
    const target = this.targets.get(info.targetId)
    if (target) {
      if (target.url !== info.url || newDocument) {
        if (target.attemptedAt !== undefined &&
            !isGooglePasskeyChallenge(info.url)) {
          console.log('[GooglePasskeyRecovery] Google verification prompt cleared after fallback')
        }
        target.url = info.url
        target.since = Date.now()
        target.generation++
        target.checks = 0
        target.attempted = false
        target.attemptedAt = undefined
        target.clearSince = undefined
        target.verificationReported = false
        target.nextCheckAt = 0
      }
    } else if (isGooglePasskeyChallenge(info.url)) {
      this.targets.set(info.targetId, {
        url: info.url, since: Date.now(), generation: 0, checks: 0, attempted: false, busy: false,
        verificationReported: false, nextCheckAt: 0, attemptTimes: [],
      })
    }
  }

  private async check(id: string, target: TargetState, socket: WebSocket): Promise<void> {
    target.busy = true
    target.checks++
    target.nextCheckAt = Date.now() + (target.verificationReported || target.checks >= FAST_CHECKS
      ? SLOW_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS)
    const generation = target.generation
    const current = () => !this.stopped && this.socket === socket &&
      this.targets.get(id) === target && target.generation === generation
    try {
      if (!target.sessionId) {
        const attached = await this.send('Target.attachToTarget', { targetId: id, flatten: true })
        // Keep attachments until browser cleanup. Repeated detach can disrupt
        // WebAuthn environments belonging to other CDP clients on the same tab.
        if (this.socket === socket) {
          target.sessionId = attached.sessionId as string
          await this.send('Page.enable', {}, target.sessionId)
        }
      }
      if (!current() || !target.sessionId) return
      target.attemptTimes = target.attemptTimes.filter(time => Date.now() - time < ATTEMPT_WINDOW_MS)
      if (!target.attempted && target.attemptTimes.length >= MAX_ATTEMPTS_PER_WINDOW) {
        // Stay in read-only mode until the prompt clears or a new visit starts.
        // Waiting out the window must not itself trigger another click.
        target.attempted = true
        console.warn('[GooglePasskeyRecovery] Paused automatic fallback after repeated challenges')
      }
      const inspection = target.attempted
      // A timeout may mean the click ran but its response was lost. Only read
      // afterward, even across reconnects, until the old prompt visibly clears.
      target.attempted = true
      if (!inspection) {
        target.attemptedAt = Date.now()
        // Reserve before dispatch: navigation, exceptions, and timeouts can
        // prevent a response even though Google's click handler already ran.
        target.attemptTimes.push(target.attemptedAt)
      }
      const expression = inspection ? GOOGLE_PASSKEY_INSPECTION_EXPRESSION : GOOGLE_PASSKEY_RECOVERY_EXPRESSION
      const result = await this.send('Runtime.evaluate', {
        expression: `location.href === ${JSON.stringify(target.url)} ? ${expression} : 'not-applicable'`,
        returnByValue: true,
      }, target.sessionId)
      if (!current()) return
      const value = (result.result as { value?: string } | undefined)?.value
      if (!inspection) {
        if (value === 'waiting' || value === 'cleared') {
          target.attempted = false
          target.attemptedAt = undefined
          target.attemptTimes.pop()
        } else {
          target.nextCheckAt = Date.now() + CHECK_INTERVAL_MS
        }
      } else if (value === 'cleared') {
        target.clearSince ??= Date.now()
        target.nextCheckAt = Date.now() + CHECK_INTERVAL_MS
        if (Date.now() - target.clearSince >= CLEAR_GRACE_MS) {
          if (target.attemptedAt !== undefined) {
            console.log('[GooglePasskeyRecovery] Google verification prompt cleared after fallback')
          }
          target.attempted = false
          target.attemptedAt = undefined
          target.clearSince = undefined
          target.verificationReported = false
          target.since = Date.now()
          target.checks = 0
        }
      } else {
        target.clearSince = undefined
      }
      if (inspection && target.attemptedAt !== undefined && !target.verificationReported) {
        target.nextCheckAt = Date.now() + CHECK_INTERVAL_MS
      }
    } catch {
      // Recovery is best effort and must never break browser launch or input.
    } finally {
      if (current() && target.attemptedAt !== undefined && !target.verificationReported &&
          Date.now() - target.attemptedAt >= VERIFY_TIMEOUT_MS) {
        target.verificationReported = true
        target.nextCheckAt = Date.now() + SLOW_CHECK_INTERVAL_MS
        console.warn('[GooglePasskeyRecovery] Could not confirm fallback cleared the verification prompt; observing without another click')
      }
      target.busy = false
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Recovery disconnected'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Recovery command timed out'))
      }, COMMAND_TIMEOUT_MS)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error('Recovery command failed'))
      })
    })
  }

  private resetConnection(): void {
    this.socket = undefined
    clearInterval(this.interval)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Recovery disconnected'))
    }
    this.pending.clear()
    for (const target of this.targets.values()) target.sessionId = undefined
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retries >= MAX_RECONNECTS) return
    this.retries++
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined
      this.connect()
    }, RECONNECT_MS)
    this.reconnect.unref()
  }
}

export class GooglePasskeyRecovery {
  private connections = new Map<string, RecoveryConnection>()

  /** Only pass the reusable Browserbase debug URL, never its single-use connectUrl. */
  watch(instanceId: string, debugUrl: string): void {
    const existing = this.connections.get(instanceId)
    if (existing?.url === debugUrl && existing.active) return
    this.stop(instanceId)
    this.connections.set(instanceId, new RecoveryConnection(debugUrl))
  }

  stop(instanceId: string): void {
    this.connections.get(instanceId)?.stop()
    this.connections.delete(instanceId)
  }
}
