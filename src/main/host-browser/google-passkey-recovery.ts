import WebSocket from 'ws'

const GRACE_MS = 2_000
const CHECK_INTERVAL_MS = 1_000
const COMMAND_TIMEOUT_MS = 5_000
const RECONNECT_MS = 5_000
const MAX_RECONNECTS = 5
const MAX_CHECKS = 60
const PASSKEY_PATH = '^/v3/signin/challenge/pk/?$'

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
 * Do not act on conditional WebAuthn, pre-prompt screens, or other challenges.
 * English copy is intentional: unfamiliar/localized UI fails closed.
 */
export const GOOGLE_PASSKEY_RECOVERY_EXPRESSION = String.raw`(() => {
  if (location.origin !== 'https://accounts.google.com' ||
      !new RegExp(${JSON.stringify(PASSKEY_PATH)}).test(location.pathname)) return 'not-applicable';

  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').replace(/\u2019/g, "'");
  if (!text.includes("Verifying it's you") ||
      !text.includes('Complete sign-in using your passkey')) return 'waiting';

  const buttons = [...document.querySelectorAll('button')].filter(button => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return button.innerText.trim() === 'Try another way' &&
      rect.width > 0 && rect.height > 0 &&
      style.visibility === 'visible' && style.display !== 'none' &&
      !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true' &&
      !button.closest('[inert]');
  });
  if (buttons.length !== 1) return 'waiting';
  buttons[0].click();
  return 'clicked';
})()`

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
          if (isGooglePasskeyChallenge(target.url) && !target.busy && !target.attempted &&
              target.checks < MAX_CHECKS && Date.now() - target.since >= GRACE_MS) {
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
        target.url = info.url
        target.since = Date.now()
        target.generation++
        target.checks = 0
        target.attempted = false
      }
    } else if (isGooglePasskeyChallenge(info.url)) {
      this.targets.set(info.targetId, {
        url: info.url, since: Date.now(), generation: 0, checks: 0, attempted: false, busy: false,
      })
    }
  }

  private async check(id: string, target: TargetState, socket: WebSocket): Promise<void> {
    target.busy = true
    target.checks++
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
      // A timeout may mean the click ran but its response was lost. Never retry
      // an ambiguous evaluation during this challenge, even after reconnecting.
      target.attempted = true
      const result = await this.send('Runtime.evaluate', {
        expression: `location.href === ${JSON.stringify(target.url)} ? ${GOOGLE_PASSKEY_RECOVERY_EXPRESSION} : 'not-applicable'`,
        returnByValue: true,
      }, target.sessionId)
      if (!current()) return
      const value = (result.result as { value?: string } | undefined)?.value
      if (value === 'waiting') target.attempted = false
      if (value === 'clicked') console.log('[GooglePasskeyRecovery] Invoked Google passkey fallback')
    } catch {
      // Recovery is best effort and must never break browser launch or input.
    } finally {
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
