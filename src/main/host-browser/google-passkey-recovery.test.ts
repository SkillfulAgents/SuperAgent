import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GooglePasskeyRecovery } from './google-passkey-recovery'

type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
type TestSocket = {
  commands: Command[]
  readyState: number
  event: (method: string, params: Record<string, unknown>, sessionId?: string) => void
  reply: (command: Command, result: Record<string, unknown>) => void
  terminate: () => void
}
const h = vi.hoisted(() => ({
  sockets: [] as TestSocket[],
  respond: vi.fn<(command: Command) => Record<string, unknown> | undefined>(),
}))

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: class extends EventEmitter {
    static OPEN = 1
    readyState = 0
    commands: Command[] = []
    constructor() {
      super()
      h.sockets.push(this)
      queueMicrotask(() => { this.readyState = 1; this.emit('open') })
    }
    send(data: string, callback: (error?: Error) => void) {
      const command = JSON.parse(data) as Command
      this.commands.push(command)
      const result = h.respond(command)
      if (result !== undefined) queueMicrotask(() => this.reply(command, result))
      callback()
    }
    reply(command: Command, result: Record<string, unknown>) {
      this.emit('message', Buffer.from(JSON.stringify({ id: command.id, result })))
    }
    event(method: string, params: Record<string, unknown>, sessionId?: string) {
      this.emit('message', Buffer.from(JSON.stringify({ method, params, sessionId })))
    }
    terminate() {
      this.readyState = 3
      this.emit('close')
    }
  } }
})

const challenge = 'https://accounts.google.com/v3/signin/challenge/pk?flow=test'
const info = (targetId = 'tab', url = challenge, type = 'page') => ({ targetId, url, type })
const evaluations = (socket = h.sockets[0]) => socket.commands.filter(c => c.method === 'Runtime.evaluate')
let recovery: GooglePasskeyRecovery

beforeEach(() => {
  vi.useFakeTimers()
  h.sockets.length = 0
  h.respond.mockReset().mockImplementation(command => {
    if (command.method === 'Target.getTargets') return { targetInfos: [info()] }
    if (command.method === 'Target.attachToTarget') return { sessionId: `attached-${command.params.targetId}` }
    if (command.method === 'Runtime.evaluate') return { result: { value: 'clicked' } }
    return {}
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  recovery = new GooglePasskeyRecovery()
})

afterEach(() => {
  recovery.stop('instance')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function start() {
  recovery.watch('instance', 'wss://example.test/reusable-debug')
  await vi.advanceTimersByTimeAsync(0)
  return h.sockets[0]
}

describe('Google passkey observer', () => {
  it('recovers an already-open challenge once after a grace period, without emulating WebAuthn', async () => {
    const socket = await start()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(evaluations()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(evaluations()).toHaveLength(1)
    expect(evaluations()[0].sessionId).toBe('attached-tab')
    expect(evaluations()[0].params.expression).toContain(JSON.stringify(challenge))
    socket.event('Target.targetInfoChanged', { targetInfo: { ...info(), title: 'Changed title' } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(evaluations()).toHaveLength(1)
    expect(socket.commands.some(c => c.method.startsWith('WebAuthn.'))).toBe(false)
  })

  it('discovers new popup tabs, but ignores passwords, pre-prompts, other origins and frames', async () => {
    h.respond.mockImplementation(command => {
      if (command.method === 'Target.getTargets') return { targetInfos: [] }
      if (command.method === 'Target.attachToTarget') return { sessionId: 'popup-session' }
      return { result: { value: 'clicked' } }
    })
    const socket = await start()
    for (const targetInfo of [
      info('password', 'https://accounts.google.com/v3/signin/challenge/pwd'),
      info('pre-prompt', 'https://accounts.google.com/v3/signin/challenge/pk/presend'),
      info('other-origin', 'https://example.com/v3/signin/challenge/pk'),
      info('frame', challenge, 'iframe'),
    ]) socket.event('Target.targetCreated', { targetInfo })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(evaluations()).toHaveLength(0)
    socket.event('Target.targetCreated', { targetInfo: info('popup') })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(evaluations()).toHaveLength(1)
    expect(evaluations()[0].sessionId).toBe('popup-session')
  })

  it('waits for recognizable DOM and rearms only on a new challenge visit', async () => {
    const original = h.respond.getMockImplementation()!
    let ready = false
    h.respond.mockImplementation(command => command.method === 'Runtime.evaluate'
      ? { result: { value: ready ? 'clicked' : 'waiting' } } : original(command))
    const socket = await start()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(evaluations()).toHaveLength(2)
    ready = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(evaluations()).toHaveLength(3)
    socket.event('Target.targetInfoChanged', { targetInfo: info('tab', 'https://accounts.google.com/v3/signin/challenge/selection') })
    socket.event('Target.targetInfoChanged', { targetInfo: info() })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(evaluations()).toHaveLength(4)
    expect(socket.commands.filter(c => c.method === 'Target.attachToTarget')).toHaveLength(1)
  })


  it('rearms on a new document at the same URL but not on subframe navigation', async () => {
    const socket = await start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(evaluations()).toHaveLength(1)
    socket.event('Page.frameNavigated', { frame: { url: challenge, parentId: 'main-frame' } }, 'attached-tab')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(evaluations()).toHaveLength(1)
    socket.event('Page.frameNavigated', { frame: { url: challenge } }, 'attached-tab')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(evaluations()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(evaluations()).toHaveLength(2)
  })

  it.each(['navigate', 'destroy', 'stop'])('does not click if the target changes during attachment: %s', async action => {
    const original = h.respond.getMockImplementation()!
    h.respond.mockImplementation(c => c.method === 'Target.attachToTarget' ? undefined : original(c))
    const socket = await start()
    await vi.advanceTimersByTimeAsync(2_000)
    const attach = socket.commands.find(c => c.method === 'Target.attachToTarget')!
    if (action === 'navigate') socket.event('Target.targetInfoChanged', { targetInfo: info('tab', 'https://example.com') })
    if (action === 'destroy') socket.event('Target.targetDestroyed', { targetId: 'tab' })
    if (action === 'stop') recovery.stop('instance')
    socket.reply(attach, { sessionId: 'late-attachment' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(evaluations()).toHaveLength(0)
  })

  it('does not repeat a potentially delivered click after a timeout or connection loss', async () => {
    const original = h.respond.getMockImplementation()!
    h.respond.mockImplementation(c => c.method === 'Runtime.evaluate' ? undefined : original(c))
    const socket = await start()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(evaluations()).toHaveLength(1)
    socket.terminate()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(h.sockets).toHaveLength(2)
    expect(evaluations(h.sockets[1])).toHaveLength(0)
  })

  it('reconnects and resumes detection when disconnected before an action', async () => {
    const socket = await start()
    socket.terminate()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(h.sockets).toHaveLength(2)
    expect(evaluations(h.sockets[1])).toHaveLength(1)
    recovery.stop('instance')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.sockets).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds DOM polling when the page never matches', async () => {
    const original = h.respond.getMockImplementation()!
    h.respond.mockImplementation(c => c.method === 'Runtime.evaluate' ? { result: { value: 'waiting' } } : original(c))
    await start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(evaluations()).toHaveLength(60)
  })


  it('bounds retries for an expired endpoint and can restart on the next provider launch', async () => {
    h.respond.mockReturnValue(undefined)
    await start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.sockets).toHaveLength(6)
    expect(vi.getTimerCount()).toBe(0)
    recovery.watch('instance', 'wss://example.test/reusable-debug')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sockets).toHaveLength(7)
  })

  it('keeps one observer for reuse and disposes the old connection when the browser changes', async () => {
    const old = await start()
    recovery.watch('instance', 'wss://example.test/reusable-debug')
    expect(h.sockets).toHaveLength(1)
    recovery.watch('instance', 'wss://example.test/another-debug')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sockets).toHaveLength(2)
    expect(old.readyState).toBe(3)
    recovery.stop('instance')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})
