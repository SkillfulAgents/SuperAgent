import { createHash, randomUUID } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { getDataDir } from '@shared/lib/config/data-dir'

const EXTENSION_IDS = [
  'pejdijmoenmkgeppbflobdenhhabjlaj',
  'mfbcdcnpokpoajjciilocoachedjkima',
] as const
const NATIVE_HOST_NAME = 'com.apple.passwordmanager'
const NATIVE_MANIFEST_PATH = `/Library/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SESSION_READY = 'SessionKeySet'

const QUERY_FUNCTION = `async function(command, url, username) {
  if (typeof g_theState === 'undefined' || g_theState !== 'SessionKeySet') {
    throw new Error('APPLE_PASSWORDS_NOT_PAIRED');
  }
  if (!g_nativeAppPort || !g_secretSession) {
    throw new Error('APPLE_PASSWORDS_NATIVE_HOST_UNAVAILABLE');
  }

  const isList = command === 4;
  const queryId = isList ? 'CmdGetLoginNames4URL' : 'CmdGetPassword4LoginName';
  const body = isList
    ? { ACT: 5, URL: url }
    : { ACT: 2, URL: url, USR: username || '' };

  return await new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      g_nativeAppPort.onMessage.removeListener(onMessage);
    };
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      cleanup();
      fn(value);
    };
    const onMessage = (message) => {
      if (!message || message.cmd !== command) return;
      try {
        let payload = message.payload;
        if (typeof payload === 'string') payload = JSON.parse(payload);
        const decoded = payload && payload.SMSG
          ? JSON.parse(g_secretSession.parseSMSG(payload.SMSG))
          : { STATUS: typeof message.STATUS === 'number' ? message.STATUS : 0 };
        finish(resolve, decoded);
      } catch (error) {
        finish(reject, new Error('APPLE_PASSWORDS_RESPONSE_INVALID'));
      }
    };
    const timer = setTimeout(
      () => finish(reject, new Error('APPLE_PASSWORDS_QUERY_TIMEOUT')),
      15000,
    );
    g_nativeAppPort.onMessage.addListener(onMessage);
    try {
      const encrypted = g_secretSession.createSMSG(JSON.stringify(body));
      g_nativeAppPort.postMessage({
        cmd: command,
        tabId: 1,
        frameId: 1,
        url,
        payload: JSON.stringify({ QID: queryId, SMSG: encrypted }),
      });
    } catch (error) {
      finish(reject, new Error('APPLE_PASSWORDS_QUERY_FAILED'));
    }
  });
}`

const READ_STATE_FUNCTION = `function() {
  return {
    state: typeof g_theState === 'undefined' ? null : String(g_theState),
    nativeReady: typeof g_nativeAppPort !== 'undefined' && !!g_nativeAppPort &&
      typeof DefaultCapabilities !== 'undefined' &&
      typeof g_nativeAppCapabilities !== 'undefined' &&
      g_nativeAppCapabilities !== DefaultCapabilities,
  };
}`

const BEGIN_PAIRING_FUNCTION = `function() {
  const state = typeof g_theState === 'undefined' ? null : String(g_theState);
  if (state === 'SessionKeySet') return { status: 'ready', state };
  if (typeof ChallengePIN !== 'function') throw new Error('APPLE_PASSWORDS_PAIRING_UNAVAILABLE');
  if (state === 'NotInSession') ChallengePIN();
  return { status: 'pin_required', state };
}`

const COMPLETE_PAIRING_FUNCTION = `function(pin) {
  if (typeof PINSet !== 'function') throw new Error('APPLE_PASSWORDS_PAIRING_UNAVAILABLE');
  PINSet(pin);
  return true;
}`

type RuntimeErrorCode =
  | 'unsupported_platform'
  | 'extension_not_found'
  | 'extension_invalid'
  | 'native_host_missing'
  | 'chrome_missing'
  | 'browser_start_failed'
  | 'service_worker_missing'
  | 'not_paired'
  | 'pairing_failed'
  | 'query_failed'

export class ApplePasswordsRuntimeError extends Error {
  constructor(public readonly code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'ApplePasswordsRuntimeError'
  }
}

export interface InstalledApplePasswordsExtension {
  id: string
  version: string
  path: string
}

interface CdpTargetInfo {
  targetId: string
  type: string
  url: string
}

interface PendingCdpCall {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

class CdpConnection {
  private socket: WebSocket | null = null
  private nextId = 0
  private readonly pending = new Map<number, PendingCdpCall>()

  async connect(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url)
      const onError = () => reject(new Error('Could not connect to Chrome debugging endpoint'))
      socket.once('error', onError)
      socket.once('open', () => {
        socket.off('error', onError)
        this.socket = socket
        resolve()
      })
      socket.on('message', (raw) => {
        let message: { id?: number; result?: unknown; error?: { message?: string } }
        try {
          message = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (typeof message.id !== 'number') return
        const call = this.pending.get(message.id)
        if (!call) return
        this.pending.delete(message.id)
        if (message.error) call.reject(new Error(message.error.message || 'CDP command failed'))
        else call.resolve(message.result)
      })
      socket.on('close', () => {
        for (const call of this.pending.values()) call.reject(new Error('Chrome debugging connection closed'))
        this.pending.clear()
        this.socket = null
      })
    })
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Chrome debugging connection is not open'))
    }
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}

function extensionIdFromKey(key: string): string | null {
  try {
    const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)
    return [...digest.toString('hex')].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('')
  } catch {
    return null
  }
}

function chromeExtensionRoots(): string[] {
  const home = os.homedir()
  return [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Chromium'),
    path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
  ]
}

function directories(parent: string): string[] {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export function findInstalledApplePasswordsExtension(
  roots: string[] = chromeExtensionRoots(),
): InstalledApplePasswordsExtension | null {
  const candidates: InstalledApplePasswordsExtension[] = []
  for (const root of roots) {
    for (const profile of directories(root)) {
      for (const id of EXTENSION_IDS) {
        const extensionRoot = path.join(root, profile, 'Extensions', id)
        for (const versionDir of directories(extensionRoot)) {
          const candidatePath = path.join(extensionRoot, versionDir)
          try {
            const manifest = JSON.parse(fs.readFileSync(path.join(candidatePath, 'manifest.json'), 'utf8')) as {
              key?: unknown
              version?: unknown
              background?: { service_worker?: unknown }
            }
            if (typeof manifest.key !== 'string' || extensionIdFromKey(manifest.key) !== id) continue
            if (typeof manifest.version !== 'string' || manifest.background?.service_worker !== 'background.js') continue
            if (!fs.existsSync(path.join(candidatePath, 'background.js'))) continue
            candidates.push({ id, version: manifest.version, path: candidatePath })
          } catch {
            // Ignore incomplete or malformed extension installs.
          }
        }
      }
    }
  }
  return candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0] || null
}

async function unusedLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function applePasswordsChromeArguments(profileDir: string, port: number): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--enable-unsafe-extension-debugging',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ]
}

export interface ApplePasswordsRuntimeLike {
  state(): Promise<{ state: string | null; nativeReady: boolean }>
  beginPairing(): Promise<{ status: 'ready' | 'pin_required' }>
  completePairing(pin: string): Promise<void>
  list(url: string): Promise<unknown>
  retrieve(url: string, username: string): Promise<unknown>
  shutdown(): Promise<void>
}

export interface ApplePasswordsRuntimeDependencies {
  platform(): NodeJS.Platform
  findExtension(): InstalledApplePasswordsExtension | null
  pathExists(candidatePath: string): boolean
  spawnChrome(command: string, args: string[], options: { stdio: 'ignore' }): ChildProcess
}

const DEFAULT_RUNTIME_DEPENDENCIES: ApplePasswordsRuntimeDependencies = {
  platform: () => process.platform,
  findExtension: () => findInstalledApplePasswordsExtension(),
  pathExists: (candidatePath) => fs.existsSync(candidatePath),
  spawnChrome: (command, args, options) => spawn(command, args, options),
}

/** Host-managed Apple Passwords session backed by an unmodified local extension copy. */
export class ApplePasswordsRuntime implements ApplePasswordsRuntimeLike {
  private child: ChildProcess | null = null
  private cdp: CdpConnection | null = null
  private extension: InstalledApplePasswordsExtension | null = null
  private serviceWorkerTargetId: string | null = null
  private serviceWorkerSessionId: string | null = null
  private serviceWorkerGlobalObjectId: string | null = null
  private startPromise: Promise<void> | null = null
  private operationChain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dependencies: ApplePasswordsRuntimeDependencies = DEFAULT_RUNTIME_DEPENDENCIES,
  ) {}

  // Electron installs SUPERAGENT_DATA_DIR during startup, after modules have
  // loaded. Resolve these paths lazily so dev and packaged runtimes use the
  // same app-owned data root as every other service.
  private get runtimeRoot(): string {
    return path.join(getDataDir(), 'credential-broker', 'apple-passwords')
  }

  private get profileDir(): string {
    return path.join(this.runtimeRoot, 'chrome-profile')
  }

  private get extensionDir(): string {
    return path.join(this.runtimeRoot, 'extension')
  }

  async state(): Promise<{ state: string | null; nativeReady: boolean }> {
    // Status checks are deliberately side-effect-free. Settings and an
    // unconfigured request card may probe prerequisites, but only an explicit
    // pairing action is allowed to launch the broker Chrome.
    this.validatePrerequisites()
    if (this.startPromise) await this.startPromise
    if (!this.child || !this.cdp || !this.extension) {
      return { state: null, nativeReady: false }
    }
    return await this.callServiceWorker(READ_STATE_FUNCTION, []) as { state: string | null; nativeReady: boolean }
  }

  async beginPairing(): Promise<{ status: 'ready' | 'pin_required' }> {
    await this.ensureStarted()
    const initial = await this.callServiceWorker(BEGIN_PAIRING_FUNCTION, []) as {
      status: 'ready' | 'pin_required'
    }
    if (initial.status === 'ready') return initial
    // The native helper displays the PIN independently. Returning immediately
    // keeps the exact browser/native session alive while the user reads it;
    // waiting for a particular private state label proved version-sensitive.
    return { status: 'pin_required' }
  }

  async completePairing(pin: string): Promise<void> {
    if (!/^\d{6}$/.test(pin)) {
      throw new ApplePasswordsRuntimeError('pairing_failed', 'Enter the six-digit Apple Passwords code')
    }
    await this.ensureStarted()

    // ChallengePIN sends PAKE m0 to the native helper. PINSet cannot run until
    // the helper answers with its m0 payload and the extension reaches MSG1Set.
    // This is normally near-instantaneous, but the API request can beat it.
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = await this.state()
      if (current.state === SESSION_READY) return
      if (current.state === 'MSG1Set') break
      if (current.state === 'NotInSession' && attempt > 5) {
        throw new ApplePasswordsRuntimeError('pairing_failed', 'Apple Passwords pairing expired')
      }
      await sleep(100)
    }
    const challenge = await this.state()
    if (challenge.state !== 'MSG1Set') {
      throw new ApplePasswordsRuntimeError('pairing_failed', 'Apple Passwords pairing expired')
    }

    await this.callServiceWorker(COMPLETE_PAIRING_FUNCTION, [pin])
    for (let attempt = 0; attempt < 60; attempt++) {
      const current = await this.state()
      if (current.state === SESSION_READY) return
      if (current.state === 'NotInSession' && attempt > 5) break
      await sleep(100)
    }
    throw new ApplePasswordsRuntimeError('pairing_failed', 'Apple Passwords rejected the pairing code')
  }

  async list(url: string): Promise<unknown> {
    return await this.serialized(() => this.query(4, url, ''))
  }

  async retrieve(url: string, username: string): Promise<unknown> {
    return await this.serialized(() => this.query(5, url, username))
  }

  async shutdown(): Promise<void> {
    // If shutdown races lazy startup, let startup settle first so it cannot
    // spawn Chrome after the teardown has already run.
    if (this.startPromise) await this.startPromise.catch(() => undefined)
    this.stop()
  }

  private stop(): void {
    this.cdp?.close()
    this.cdp = null
    this.serviceWorkerTargetId = null
    this.serviceWorkerSessionId = null
    this.serviceWorkerGlobalObjectId = null
    if (this.child && !this.child.killed) this.child.kill('SIGTERM')
    this.child = null
    this.extension = null
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation)
    this.operationChain = result.catch(() => undefined)
    return await result
  }

  private async query(command: 4 | 5, url: string, username: string): Promise<unknown> {
    const current = await this.state()
    if (current.state !== SESSION_READY) {
      throw new ApplePasswordsRuntimeError('not_paired', 'Connect Apple Passwords to continue')
    }
    try {
      return await this.callServiceWorker(QUERY_FUNCTION, [command, url, username])
    } catch (error) {
      if (error instanceof ApplePasswordsRuntimeError) throw error
      throw new ApplePasswordsRuntimeError('query_failed', 'Apple Passwords could not complete the request')
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.cdp && this.extension) return
    if (this.startPromise) return await this.startPromise
    this.startPromise = this.start()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async start(): Promise<void> {
    const extension = this.validatePrerequisites()

    this.prepareRuntime(extension)
    const port = await unusedLoopbackPort()
    const child = this.dependencies.spawnChrome(
      CHROME_PATH,
      applePasswordsChromeArguments(this.profileDir, port),
      { stdio: 'ignore' },
    )
    this.child = child
    child.once('exit', () => {
      if (this.child !== child) return
      this.cdp?.close()
      this.cdp = null
      this.serviceWorkerTargetId = null
      this.serviceWorkerSessionId = null
      this.serviceWorkerGlobalObjectId = null
      this.child = null
      this.extension = null
    })

    try {
      const debuggerUrl = await this.waitForDebugger(port, child)
      const cdp = new CdpConnection()
      await cdp.connect(debuggerUrl)
      await cdp.send('Extensions.loadUnpacked', { path: this.extensionDir })
      this.cdp = cdp
      this.extension = extension
      await this.waitForServiceWorker()
      await this.waitForNativeHost()
    } catch (error) {
      this.stop()
      if (error instanceof ApplePasswordsRuntimeError) throw error
      throw new ApplePasswordsRuntimeError('browser_start_failed', 'Could not start the Apple Passwords broker')
    }
  }

  /** Pure filesystem/platform validation; never prepares a profile or launches Chrome. */
  private validatePrerequisites(): InstalledApplePasswordsExtension {
    if (this.dependencies.platform() !== 'darwin') {
      throw new ApplePasswordsRuntimeError('unsupported_platform', 'Apple Passwords is available only on macOS')
    }
    const extension = this.dependencies.findExtension()
    if (!extension) {
      throw new ApplePasswordsRuntimeError(
        'extension_not_found',
        'Install the iCloud Passwords extension in Chrome to enable saved logins',
      )
    }
    if (!this.dependencies.pathExists(CHROME_PATH)) {
      throw new ApplePasswordsRuntimeError('chrome_missing', 'Google Chrome is required for Apple Passwords')
    }
    if (!this.dependencies.pathExists(NATIVE_MANIFEST_PATH)) {
      throw new ApplePasswordsRuntimeError('native_host_missing', 'The Apple Passwords native helper is unavailable')
    }
    return extension
  }

  private prepareRuntime(extension: InstalledApplePasswordsExtension): void {
    fs.mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 })
    fs.chmodSync(this.runtimeRoot, 0o700)
    const staging = `${this.extensionDir}.staging-${randomUUID()}`
    fs.cpSync(extension.path, staging, {
      recursive: true,
      filter: (source) => path.basename(source) !== '_metadata',
    })
    fs.rmSync(this.extensionDir, { recursive: true, force: true })
    fs.renameSync(staging, this.extensionDir)

    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 })
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      fs.rmSync(path.join(this.profileDir, lock), { force: true })
    }
    const nativeHosts = path.join(this.profileDir, 'NativeMessagingHosts')
    fs.mkdirSync(nativeHosts, { recursive: true, mode: 0o700 })
    fs.copyFileSync(NATIVE_MANIFEST_PATH, path.join(nativeHosts, `${NATIVE_HOST_NAME}.json`))
  }

  private async waitForDebugger(port: number, child: ChildProcess): Promise<string> {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) break
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) {
          const data = await response.json() as { webSocketDebuggerUrl?: unknown }
          if (typeof data.webSocketDebuggerUrl === 'string') return data.webSocketDebuggerUrl
        }
      } catch {
        // Chrome is still starting.
      }
      await sleep(100)
    }
    throw new ApplePasswordsRuntimeError('browser_start_failed', 'Chrome did not expose its debugging endpoint')
  }

  private async target(): Promise<CdpTargetInfo> {
    const result = await this.cdp!.send<{ targetInfos?: CdpTargetInfo[] }>('Target.getTargets')
    const target = result.targetInfos?.find((candidate) =>
      candidate.type === 'service_worker' &&
      candidate.url === `chrome-extension://${this.extension!.id}/background.js`
    )
    if (!target) throw new ApplePasswordsRuntimeError('service_worker_missing', 'Apple Passwords did not start')
    return target
  }

  private async waitForServiceWorker(): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        await this.target()
        return
      } catch {
        await sleep(100)
      }
    }
    throw new ApplePasswordsRuntimeError('service_worker_missing', 'Apple Passwords did not start')
  }

  private async waitForNativeHost(): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const current = await this.callServiceWorker(READ_STATE_FUNCTION, []) as {
          state: string | null
          nativeReady: boolean
        }
        if (
          current.nativeReady &&
          current.state &&
          ['NotInSession', 'ChallengeSent', 'MSG1Set', SESSION_READY].includes(current.state)
        ) return
      } catch {
        // The extension is still initializing.
      }
      await sleep(100)
    }
    throw new ApplePasswordsRuntimeError('native_host_missing', 'The Apple Passwords native helper did not connect')
  }

  private async callServiceWorker(functionDeclaration: string, args: unknown[]): Promise<unknown> {
    if (!this.cdp || !this.extension) {
      throw new ApplePasswordsRuntimeError('browser_start_failed', 'Apple Passwords is not running')
    }
    await this.ensureServiceWorkerSession()
    const sessionId = this.serviceWorkerSessionId!
    const objectId = this.serviceWorkerGlobalObjectId!
    try {
      const called = await this.cdp.send<{
        result?: { value?: unknown; subtype?: string; description?: string }
        exceptionDetails?: unknown
      }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        awaitPromise: true,
        returnByValue: true,
      }, sessionId)
      if (called.exceptionDetails || called.result?.subtype === 'error') {
        throw new Error(called.result?.description || 'Apple Passwords operation failed')
      }
      return called.result?.value
    } catch (error) {
      // A service worker can still be replaced after an extension update or
      // native-host reconnect. Drop the cached execution context so the next
      // operation reattaches cleanly.
      this.serviceWorkerTargetId = null
      this.serviceWorkerSessionId = null
      this.serviceWorkerGlobalObjectId = null
      throw error
    }
  }

  private async ensureServiceWorkerSession(): Promise<void> {
    const target = await this.target()
    if (
      this.serviceWorkerTargetId === target.targetId &&
      this.serviceWorkerSessionId &&
      this.serviceWorkerGlobalObjectId
    ) return

    const attached = await this.cdp!.send<{ sessionId?: string }>('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    if (!attached.sessionId) {
      throw new ApplePasswordsRuntimeError('service_worker_missing', 'Could not attach to Apple Passwords')
    }
    const globalResult = await this.cdp!.send<{
      result?: { objectId?: string }
      exceptionDetails?: unknown
    }>('Runtime.evaluate', { expression: 'globalThis', returnByValue: false }, attached.sessionId)
    const objectId = globalResult.result?.objectId
    if (!objectId || globalResult.exceptionDetails) {
      throw new ApplePasswordsRuntimeError('service_worker_missing', 'Apple Passwords execution context is unavailable')
    }
    this.serviceWorkerTargetId = target.targetId
    this.serviceWorkerSessionId = attached.sessionId
    this.serviceWorkerGlobalObjectId = objectId
  }
}
