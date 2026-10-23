import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { CdpConnection, callOnElement, callOnElementWith, locateFocusedElement } from './login-cdp'
import { DESCRIBE_ELEMENT_FUNCTION } from './login-form-script'

/** A handler's way to leave a call unanswered. */
const NO_ANSWER = Symbol('no answer')

type Handler = (method: string, params: Record<string, any>, sessionId: string | undefined, push: (event: object) => void) => unknown

interface FakeCdp {
  url: string
  calls: Array<{ method: string; params: Record<string, any>; sessionId?: string }>
  close: () => Promise<void>
}

/** A CDP endpoint answering from a handler; a thrown Error becomes a CDP error. */
async function fakeCdp(handler: Handler): Promise<FakeCdp> {
  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const calls: FakeCdp['calls'] = []
  server.on('connection', (socket: WebSocket) => {
    const push = (event: object) => socket.send(JSON.stringify(event))
    socket.on('message', (raw) => {
      const { id, method, params, sessionId } = JSON.parse(raw.toString())
      calls.push({ method, params, sessionId })
      try {
        const result = handler(method, params ?? {}, sessionId, push) ?? {}
        if (result === NO_ANSWER) return
        socket.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        socket.send(JSON.stringify({ id, error: { message: (error as Error).message } }))
      }
    })
  })
  const port = (server.address() as { port: number }).port
  return {
    url: `ws://127.0.0.1:${port}/devtools/page/T1`,
    calls,
    close: () => new Promise((resolve) => {
      // Open sockets keep close() waiting: end them, so a failed assertion
      // cannot turn into a teardown timeout.
      for (const client of server.clients) client.terminate()
      server.close(() => resolve())
    }),
  }
}

const input = (type: string, origin = 'https://github.com') => ({
  tag: 'input', type, isFrame: false, origin, url: `${origin}/login`,
  box: { x: 1, y: 2, width: 3, height: 4 }, rendered: true, disabled: false, readOnly: false,
  inputMode: '', autocomplete: '', maxLength: -1,
})
const frameElement = { ...input(''), tag: 'iframe', type: '', isFrame: true }

/**
 * A page whose focus chain is described per frame: each frame's active
 * element, and which frames live in another process (their own target).
 */
function page(chain: Record<string, { active: object | null; childFrame?: string }>, oopif: Record<string, string> = {}, attachLate = false): Handler {
  let contexts = 0
  const contextFrame = new Map<number, string>()
  const objects = new Map<string, string>()
  const attachedSessions = new Set<string>()
  return (method, params, sessionId, push) => {
    switch (method) {
      case 'Target.attachToTarget': return { sessionId: 'S-page' }
      case 'Target.setAutoAttach': {
        if (!attachLate && (sessionId === undefined || sessionId === 'S-page')) {
          for (const [frameId, childSession] of Object.entries(oopif)) {
            setTimeout(() => push({ method: 'Target.attachedToTarget', params: { sessionId: childSession, targetInfo: { targetId: frameId, type: 'iframe' } } }), 5)
          }
        }
        return {}
      }
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'F0' } } }
      case 'Page.createIsolatedWorld': {
        const owner = Object.entries(oopif).find(([frameId]) => frameId === params.frameId)
        const inProcess = !owner && chain[params.frameId]
        if (owner && sessionId !== owner[1]) {
          if (attachLate && !attachedSessions.has(owner[1])) {
            attachedSessions.add(owner[1])
            setTimeout(() => push({ method: 'Target.attachedToTarget', params: { sessionId: owner[1], targetInfo: { targetId: owner[0], type: 'iframe' } } }), 20)
          }
          throw new Error('No frame for given id found')
        }
        if (!owner && !inProcess) throw new Error('No frame for given id found')
        const id = ++contexts
        contextFrame.set(id, params.frameId)
        return { executionContextId: id }
      }
      case 'Runtime.evaluate': {
        const frameId = contextFrame.get(params.contextId)!
        if (!chain[frameId].active) return { result: { type: 'object', subtype: 'null', value: null } }
        objects.set(`obj:${frameId}`, frameId)
        return { result: { objectId: `obj:${frameId}` } }
      }
      case 'Runtime.callFunctionOn': {
        if (params.functionDeclaration === DESCRIBE_ELEMENT_FUNCTION) {
          return { result: { value: chain[objects.get(params.objectId)!].active } }
        }
        if (params.functionDeclaration.includes('throw')) return { result: {}, exceptionDetails: { text: 'Uncaught' } }
        return { result: { value: { echoed: params.arguments } } }
      }
      case 'DOM.describeNode': return { node: { frameId: chain[objects.get(params.objectId)!].childFrame } }
      default: return {}
    }
  }
}

let fake: FakeCdp | null = null
afterEach(async () => {
  await fake?.close()
  fake = null
})

describe('locateFocusedElement', () => {
  it('finds the focused field in the main frame, in an isolated world', async () => {
    fake = await fakeCdp(page({ F0: { active: input('email') } }))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    const found = await locateFocusedElement(cdp)
    cdp.close()
    expect(found).toEqual({ sessionId: undefined, objectId: 'obj:F0', frameId: 'F0', description: input('email'), topOrigin: 'https://github.com' })
    expect(fake.calls.find((c) => c.method === 'Page.createIsolatedWorld')?.params).toMatchObject({ frameId: 'F0', grantUniveralAccess: false })
    // No domain is enabled: page scripts see nothing of this connection.
    expect(fake.calls.some((c) => c.method.endsWith('.enable'))).toBe(false)
  })

  it('follows focus into an in-process frame', async () => {
    fake = await fakeCdp(page({
      F0: { active: frameElement, childFrame: 'F1' },
      F1: { active: input('password', 'https://login.github.com') },
    }))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    const found = await locateFocusedElement(cdp)
    cdp.close()
    expect(found).toMatchObject({ objectId: 'obj:F1', frameId: 'F1', description: { origin: 'https://login.github.com' }, topOrigin: 'https://github.com' })
  })

  it('hands every event to its listeners with the session it came on, until they unsubscribe', async () => {
    let pushEvent: ((event: object) => void) | null = null
    fake = await fakeCdp((method, _params, _sessionId, push) => { pushEvent = push; return {} })
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    const seen: Array<{ method: string; sessionId: string | undefined }> = []
    const stop = cdp.onEvent(({ method, sessionId }) => seen.push({ method, sessionId }))
    pushEvent!({ method: 'Page.frameStartedLoading', params: { frameId: 'F0' } })
    pushEvent!({ method: 'Network.requestWillBeSent', params: { frameId: 'F1' }, sessionId: 'S-child' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop()
    pushEvent!({ method: 'Page.frameStartedLoading', params: { frameId: 'F0' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    cdp.close()
    expect(seen).toEqual([
      { method: 'Page.frameStartedLoading', sessionId: undefined },
      { method: 'Network.requestWillBeSent', sessionId: 'S-child' },
    ])
  })

  it('follows focus into an out-of-process frame through its attached target', async () => {
    fake = await fakeCdp(page(
      { F0: { active: frameElement, childFrame: 'F1' }, F1: { active: input('password', 'https://accounts.example') } },
      { F1: 'S-child' },
    ))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const found = await locateFocusedElement(cdp)
    cdp.close()
    expect(found).toMatchObject({ sessionId: 'S-child', objectId: 'obj:F1' })
  })

  it('waits for an out-of-process frame that attaches after it is reached', async () => {
    fake = await fakeCdp(page(
      { F0: { active: frameElement, childFrame: 'F1' }, F1: { active: input('text') } },
      { F1: 'S-late' },
      true,
    ))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    const found = await locateFocusedElement(cdp)
    cdp.close()
    expect(found).toMatchObject({ sessionId: 'S-late', objectId: 'obj:F1' })
  })

  it('attaches to the page first when the endpoint is the browser\'s', async () => {
    fake = await fakeCdp(page({ F0: { active: input('text') } }))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: true })
    const found = await locateFocusedElement(cdp)
    cdp.close()
    expect(fake.calls[0]).toMatchObject({ method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })
    expect(found).toMatchObject({ sessionId: 'S-page' })
    expect(fake.calls.filter((c) => c.method === 'Runtime.evaluate').every((c) => c.sessionId === 'S-page')).toBe(true)
  })

  it('finds nothing when no element has focus', async () => {
    fake = await fakeCdp(page({ F0: { active: null } }))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    await expect(locateFocusedElement(cdp)).resolves.toEqual({ missed: 'nothing_focused' })
    cdp.close()
  })
})

describe('the connection', () => {
  it('serves a page socket that refuses auto-attach', async () => {
    const served = page({ F0: { active: input('text') } })
    fake = await fakeCdp((method, params, sessionId, push) => {
      if (method === 'Target.setAutoAttach') throw new Error('Target domain is not available')
      return served(method, params, sessionId, push)
    })
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    await expect(locateFocusedElement(cdp)).resolves.toMatchObject({ objectId: 'obj:F0' })
    cdp.close()
  })

  it('reports an unreachable frame when the frame\'s target never attaches', async () => {
    const served = page({ F0: { active: frameElement, childFrame: 'F1' }, F1: { active: input('text') } })
    fake = await fakeCdp((method, params, sessionId, push) => {
      if (method === 'Page.createIsolatedWorld' && params.frameId === 'F1') throw new Error('No frame for given id found')
      return served(method, params, sessionId, push)
    })
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    await expect(locateFocusedElement(cdp)).resolves.toEqual({ missed: 'frame_unreachable' })
    cdp.close()
  })

  it('fails later calls at once after the other end closed the socket', async () => {
    let socket: WebSocket | null = null
    fake = await fakeCdp((method) => (method === 'Target.setAutoAttach' ? {} : NO_ANSWER))
    const server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    server.on('connection', (ws) => {
      socket = ws
      ws.on('message', (raw) => {
        const { id } = JSON.parse(raw.toString())
        ws.send(JSON.stringify({ id, result: {} }))
      })
    })
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, requiresSession: false })
    ;(socket as unknown as WebSocket).close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    await expect(cdp.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow('Runtime.evaluate: CDP connection closed')
    expect(Date.now() - started).toBeLessThan(1000)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('fails a call waiting on a frame session when that frame detaches', async () => {
    fake = await fakeCdp((method, params, sessionId, push) => {
      if (method === 'Runtime.evaluate' && sessionId === 'S-child') {
        setTimeout(() => push({ method: 'Target.detachedFromTarget', params: { sessionId: 'S-child' } }), 10)
        return NO_ANSWER
      }
      return {}
    })
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    await expect(cdp.send('Runtime.evaluate', { expression: '1' }, 'S-child')).rejects.toThrow('Runtime.evaluate: the frame detached')
    cdp.close()
  })
})

describe('callOnElement', () => {
  it('passes arguments by value and never in the source', async () => {
    fake = await fakeCdp(page({ F0: { active: input('password') } }))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    const result = await callOnElement(cdp, { sessionId: undefined, objectId: 'obj:F0' }, 'function (v) { return v }', ['hunter2-pass'])
    cdp.close()
    expect(result).toEqual({ echoed: [{ value: 'hunter2-pass' }] })
    const call = fake.calls.find((c) => c.method === 'Runtime.callFunctionOn' && c.params.arguments)!
    expect(call.params.functionDeclaration).not.toContain('hunter2')
  })

  it('throws without the arguments when the page function throws', async () => {
    fake = await fakeCdp(page({ F0: { active: input('password') } }))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    const error = await callOnElement(cdp, { sessionId: undefined, objectId: 'obj:F0' }, 'function () { throw new Error("x") }', ['hunter2-pass'])
      .catch((e: Error) => e)
    cdp.close()
    expect(String(error)).not.toContain('hunter2')
    expect(String(error)).toContain('The page function threw')
  })

  it('keeps the arguments out of a CDP error', async () => {
    fake = await fakeCdp((method) => {
      if (method === 'Runtime.callFunctionOn') throw new Error('Could not find object with given id')
      return {}
    })
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    const error = await callOnElement(cdp, { sessionId: undefined, objectId: 'obj:F0' }, 'function (v) { return v }', ['hunter2-pass']).catch((e: Error) => e)
    cdp.close()
    expect(String(error)).toBe('Error: Runtime.callFunctionOn: Could not find object with given id')
  })

  it('times out a call the page never answers, without the arguments', async () => {
    fake = await fakeCdp((method) => (method === 'Runtime.callFunctionOn' ? NO_ANSWER : {}))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    vi.useFakeTimers()
    try {
      const waiting = callOnElement(cdp, { sessionId: undefined, objectId: 'obj:F0' }, 'function (v) { return v }', ['hunter2-pass']).catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(5_000)
      const error = await waiting
      expect(String(error)).toBe('Error: Runtime.callFunctionOn: timed out')
    } finally {
      vi.useRealTimers()
      cdp.close()
    }
  })

  it('fails calls still waiting when the connection closes', async () => {
    fake = await fakeCdp((method) => (method === 'Runtime.callFunctionOn' ? NO_ANSWER : {}))
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    const waiting = callOnElement(cdp, { sessionId: undefined, objectId: 'obj:F0' }, 'function (v) { return v }', ['hunter2-pass'])
    cdp.close()
    await expect(waiting).rejects.toThrow('Runtime.callFunctionOn: CDP connection closed')
  })
})

describe('callOnElementWith', () => {
  const button = { sessionId: undefined, objectId: 'obj:button', frameId: 'F0' }
  const field = { sessionId: undefined, objectId: 'obj:field', frameId: 'F0' }
  const handler: Handler = (method, params) => {
    if (method === 'DOM.describeNode') {
      if (params.objectId === 'obj:gone') throw new Error('Could not find object with given id')
      return { node: { backendNodeId: params.objectId === 'obj:button' ? 11 : 12 } }
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
    if (method === 'DOM.resolveNode') return { object: { objectId: `ctx${params.executionContextId}:${params.backendNodeId}` } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: 'clicked' } }
    return {}
  }

  it('resolves both elements into one fresh world of their frame, the other passed as an object', async () => {
    fake = await fakeCdp(handler)
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    const result = await callOnElementWith(cdp, button, field, 'function (origin, field) { return "clicked" }', ['https://github.com'])
    cdp.close()
    expect(result).toBe('clicked')
    expect(fake.calls.filter((c) => c.method === 'Page.createIsolatedWorld').map((c) => c.params.frameId)).toEqual(['F0'])
    const call = fake.calls.find((c) => c.method === 'Runtime.callFunctionOn')!
    expect(call.params).toMatchObject({ objectId: 'ctx7:11', arguments: [{ value: 'https://github.com' }, { objectId: 'ctx7:12' }] })
  })

  it('throws, calling nothing, for elements in two frames or one gone with its document', async () => {
    fake = await fakeCdp(handler)
    const cdp = await CdpConnection.open({ id: 'T1', wsUrl: fake.url, requiresSession: false })
    await expect(callOnElementWith(cdp, button, { ...field, frameId: 'F1' }, 'function () {}', [])).rejects.toThrow('The elements are in different frames')
    await expect(callOnElementWith(cdp, button, { ...field, objectId: 'obj:gone' }, 'function () {}', [])).rejects.toThrow('Could not find object with given id')
    cdp.close()
    expect(fake.calls.some((c) => c.method === 'Runtime.callFunctionOn')).toBe(false)
  })
})
