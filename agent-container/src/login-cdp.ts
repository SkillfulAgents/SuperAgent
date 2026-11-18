import WebSocket from 'ws'
import {
  DEEP_ACTIVE_ELEMENT_EXPRESSION,
  DESCRIBE_ELEMENT_FUNCTION,
  type FocusedElementDescription,
} from './login-form-script'

/** A page as the server's target lookup returns it. */
export interface CdpPageTarget {
  id: string
  wsUrl: string
  /** The URL is the browser's endpoint: attach to the page by id first. */
  requiresSession: boolean
}

interface PendingCall {
  resolve: (result: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  sessionId: string | undefined
}

/** A CDP event, with the session it arrived on (undefined: the socket's own target). */
export interface CdpEvent {
  method: string
  params: any
  sessionId: string | undefined
}

const CALL_TIMEOUT_MS = 5_000
const OPEN_TIMEOUT_MS = 5_000
/** How long an out-of-process frame's target may take to attach. */
const CHILD_ATTACH_TIMEOUT_MS = 1_500
/** Name of the isolated world the login functions run in. */
const WORLD_NAME = 'superagent-login'

/**
 * One CDP connection to a page, with the page's out-of-process frames
 * auto-attached as flat sessions — or to the browser itself, for work across
 * its tabs (saved sessions), where only the sessions the caller attaches
 * exist. Errors never carry call arguments: they name the method only, since
 * arguments can be field values.
 */
export class CdpConnection {
  private nextId = 0
  private readonly pending = new Map<number, PendingCall>()
  /** Out-of-process frames attached under this connection: target id → session id. */
  private readonly children = new Map<string, string>()
  private readonly childWaiters = new Map<string, Array<(sessionId: string) => void>>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private closed = false
  /** The page's session, or undefined when the socket is the page's own. */
  pageSession: string | undefined

  private constructor(
    private readonly ws: WebSocket,
    /** Whether the frames of attached targets attach too (a page connection's). */
    private readonly followFrames: boolean,
    private readonly callTimeoutMs: number,
  ) {
    ws.on('message', (raw) => this.onMessage(raw.toString()))
    // Closed from the other end: later calls fail at once instead of each
    // waiting out its timeout on a socket that drops what it is sent.
    ws.on('close', () => { this.closed = true; this.failAll('CDP connection closed') })
    ws.on('error', () => this.failAll('CDP connection failed'))
  }

  private static async connect(wsUrl: string, failure: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error(failure))
      }, OPEN_TIMEOUT_MS)
      ws.once('open', () => { clearTimeout(timer); resolve() })
      ws.once('error', () => { clearTimeout(timer); reject(new Error(failure)) })
    })
    return ws
  }

  /** A connection to the browser's own endpoint, with no page attached. */
  static async openBrowser(wsUrl: string, options: { callTimeoutMs?: number } = {}): Promise<CdpConnection> {
    const ws = await CdpConnection.connect(wsUrl, 'Could not connect to the browser')
    return new CdpConnection(ws, false, options.callTimeoutMs ?? CALL_TIMEOUT_MS)
  }

  static async open(target: CdpPageTarget): Promise<CdpConnection> {
    const ws = await CdpConnection.connect(target.wsUrl, 'Could not connect to the browser page')
    const connection = new CdpConnection(ws, true, CALL_TIMEOUT_MS)
    try {
      if (target.requiresSession) {
        const attached = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.id, flatten: true })
        connection.pageSession = attached.sessionId
      }
      // Out-of-process frames attach under the page; a socket that refuses the
      // Target domain still serves forms in the page's own frames.
      await connection.autoAttach(connection.pageSession).catch(() => {})
    } catch (error) {
      connection.close()
      throw error
    }
    return connection
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${method}: CDP connection closed`))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out`))
      }, this.callTimeoutMs)
      this.pending.set(id, { resolve, reject: (error) => reject(new Error(`${method}: ${error.message}`)), timer, sessionId })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  /** Call `listener` with every event from now on; returns the unsubscribe. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The session of an out-of-process frame that has already attached. */
  knownChild(frameId: string): string | undefined {
    return this.children.get(frameId)
  }

  /** The session of an out-of-process frame, once its target has attached. */
  async childSession(frameId: string): Promise<string | null> {
    const known = this.children.get(frameId)
    if (known) return known
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.childWaiters.get(frameId)?.filter((waiter) => waiter !== onAttach)
        if (waiters?.length) this.childWaiters.set(frameId, waiters)
        else this.childWaiters.delete(frameId)
        resolve(null)
      }, CHILD_ATTACH_TIMEOUT_MS)
      const onAttach = (sessionId: string) => { clearTimeout(timer); resolve(sessionId) }
      this.childWaiters.set(frameId, [...(this.childWaiters.get(frameId) ?? []), onAttach])
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll('CDP connection closed')
    this.ws.close()
  }

  private autoAttach(sessionId: string | undefined): Promise<unknown> {
    return this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId)
  }

  private onMessage(raw: string): void {
    let message: { id?: number; method?: string; params?: any; result?: any; error?: { message?: string }; sessionId?: string }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const call = this.pending.get(message.id)
      if (!call) return
      this.pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) call.reject(new Error(message.error.message || 'failed'))
      else call.resolve(message.result)
      return
    }
    if (message.method) {
      const event: CdpEvent = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId }
      for (const listener of this.listeners) listener(event)
    }
    if (message.method === 'Target.attachedToTarget' && this.followFrames) {
      const { sessionId, targetInfo } = message.params ?? {}
      if (typeof sessionId !== 'string' || typeof targetInfo?.targetId !== 'string') return
      this.children.set(targetInfo.targetId, sessionId)
      // Frames nested inside this one attach under its session.
      void this.autoAttach(sessionId).catch(() => {})
      for (const waiter of this.childWaiters.get(targetInfo.targetId) ?? []) waiter(sessionId)
      this.childWaiters.delete(targetInfo.targetId)
    } else if (message.method === 'Target.detachedFromTarget') {
      const { sessionId } = message.params ?? {}
      for (const [targetId, child] of this.children) {
        if (child === sessionId) this.children.delete(targetId)
      }
      // A frame that navigated away answers nothing more on its session.
      for (const [id, call] of this.pending) {
        if (call.sessionId !== sessionId) continue
        clearTimeout(call.timer)
        call.reject(new Error('the frame detached'))
        this.pending.delete(id)
      }
    }
  }

  private failAll(reason: string): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error(reason))
      this.pending.delete(id)
    }
  }
}

/** An element in an isolated world of the frame that holds it. */
export interface LocatedElement {
  sessionId: string | undefined
  objectId: string
  /** The frame that holds the element. */
  frameId: string
  description: FocusedElementDescription
  /** The origin of the page's main frame, which may differ from the element's frame. */
  topOrigin: string
}

/** Why no focused element was found: nothing has focus, or focus is in a frame that could not be reached. */
export type LocateMiss = { missed: 'nothing_focused' | 'frame_unreachable' }

async function isolatedWorld(cdp: CdpConnection, frameId: string, sessionId: string | undefined): Promise<number> {
  const world = await cdp.send<{ executionContextId: number }>(
    'Page.createIsolatedWorld',
    { frameId, worldName: WORLD_NAME, grantUniveralAccess: false },
    sessionId,
  )
  return world.executionContextId
}

/**
 * The element that has keyboard focus in the page: follow the active element
 * from the main frame down through open shadow roots and frames, in-process
 * or not. A miss says whether nothing had focus or the frame holding it
 * could not be reached.
 */
export async function locateFocusedElement(cdp: CdpConnection): Promise<LocatedElement | LocateMiss> {
  const unreachable: LocateMiss = { missed: 'frame_unreachable' }
  let topOrigin = ''
  let sessionId = cdp.pageSession
  const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sessionId)
  let frameId = tree.frameTree.frame.id
  let contextId = await isolatedWorld(cdp, frameId, sessionId)
  for (let depth = 0; depth < 10; depth++) {
    const evaluated = await cdp.send<{ result?: { objectId?: string } }>(
      'Runtime.evaluate',
      { expression: DEEP_ACTIVE_ELEMENT_EXPRESSION, contextId },
      sessionId,
    )
    const objectId = evaluated.result?.objectId
    if (!objectId) return { missed: 'nothing_focused' }
    const described = await cdp.send<{ result?: { value?: FocusedElementDescription } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: DESCRIBE_ELEMENT_FUNCTION, returnByValue: true },
      sessionId,
    )
    const description = described.result?.value
    if (!description) return unreachable
    topOrigin ||= description.origin
    if (!description.isFrame) return { sessionId, objectId, frameId, description, topOrigin }

    const { node } = await cdp.send<{ node: { frameId?: string } }>('DOM.describeNode', { objectId }, sessionId)
    const childFrameId = node.frameId
    if (!childFrameId) return unreachable
    // An out-of-process frame is its own target (whose id is the frame's);
    // an in-process one is a frame of this session, where a world can be
    // created at once.
    const attached = cdp.knownChild(childFrameId)
    try {
      if (attached) {
        sessionId = attached
        contextId = await isolatedWorld(cdp, childFrameId, sessionId)
      } else {
        try {
          contextId = await isolatedWorld(cdp, childFrameId, sessionId)
        } catch {
          const child = await cdp.childSession(childFrameId)
          if (!child) return unreachable
          sessionId = child
          contextId = await isolatedWorld(cdp, childFrameId, sessionId)
        }
      }
    } catch {
      return unreachable
    }
    frameId = childFrameId
  }
  return unreachable
}

/**
 * The page's main frame as the browser reports it: no page script is
 * involved, so a page cannot claim another origin.
 */
export async function mainFrameOf(cdp: CdpConnection): Promise<{ origin: string; url: string }> {
  const tree = await cdp.send<{ frameTree: { frame: { url: string; securityOrigin?: string } } }>('Page.getFrameTree', {}, cdp.pageSession)
  const { url, securityOrigin } = tree.frameTree.frame
  let origin = securityOrigin ?? ''
  if (!origin) {
    try {
      origin = new URL(url).origin
    } catch {
      origin = ''
    }
  }
  return { origin, url }
}

/** Call a page function on a located element, with arguments passed by value. */
export async function callOnElement<T>(
  cdp: CdpConnection,
  element: Pick<LocatedElement, 'sessionId' | 'objectId'>,
  functionDeclaration: string,
  args: unknown[],
): Promise<T> {
  const response = await cdp.send<{ result?: { value?: T }; exceptionDetails?: unknown }>(
    'Runtime.callFunctionOn',
    {
      objectId: element.objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    },
    element.sessionId,
  )
  if (response.exceptionDetails) throw new Error('The page function threw')
  return response.result?.value as T
}

/**
 * Call a page function on `element` with `other` as its last argument. Objects
 * from two worlds cannot meet in one call, so both are resolved into one fresh
 * isolated world of their frame. Throws when they are in different frames, or
 * when either is gone with its document.
 */
export async function callOnElementWith<T>(
  cdp: CdpConnection,
  element: Pick<LocatedElement, 'sessionId' | 'objectId' | 'frameId'>,
  other: Pick<LocatedElement, 'sessionId' | 'objectId' | 'frameId'>,
  functionDeclaration: string,
  args: unknown[],
): Promise<T> {
  if (element.sessionId !== other.sessionId || element.frameId !== other.frameId) throw new Error('The elements are in different frames')
  const { sessionId } = element
  const backendNodeOf = async (objectId: string) =>
    (await cdp.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId }, sessionId)).node.backendNodeId
  const nodes = await Promise.all([backendNodeOf(element.objectId), backendNodeOf(other.objectId)])
  const executionContextId = await isolatedWorld(cdp, element.frameId, sessionId)
  const [target, argument] = await Promise.all(nodes.map(async (backendNodeId) => {
    const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId, executionContextId }, sessionId)
    if (!object.objectId) throw new Error('An element could not be resolved')
    return object.objectId
  }))
  const response = await cdp.send<{ result?: { value?: T }; exceptionDetails?: unknown }>(
    'Runtime.callFunctionOn',
    {
      objectId: target,
      functionDeclaration,
      arguments: [...args.map((value) => ({ value })), { objectId: argument }],
      returnByValue: true,
    },
    sessionId,
  )
  if (response.exceptionDetails) throw new Error('The page function threw')
  return response.result?.value as T
}
