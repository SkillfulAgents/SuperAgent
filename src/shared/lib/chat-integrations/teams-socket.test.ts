import { afterEach, expect, it, vi } from 'vitest'
import { App, NegotiateError } from '@microsoft/teams.apps/dist/index.js'
import { SignalRSocketConnection } from '@microsoft/teams.apps/dist/socket-mode/socket-connection.js'
import type { SocketConnectionHandlers } from '@microsoft/teams.apps/dist/socket-mode/types.js'
import { TeamsConnector } from './teams-connector'
import { createTeamsSocket } from './teams-socket'

const config = {
  tenantId: 'a22d0adb-d201-4fa6-bbcc-95ece22932e3', appId: '38d36af9-2ef3-4aef-9110-c457c474dcfa',
  clientSecret: 'test-only-secret', deliveryMode: 'socket' as const,
}
const message = {
  id: 'message-1', type: 'message', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/amer/',
  conversation: { id: 'conversation', conversationType: 'personal', tenantId: config.tenantId }, text: 'Hello',
  from: { id: '29:user', aadObjectId: '4c123964-c20e-4951-8f95-fd65774b3204' }, recipient: { id: `28:${config.appId}` },
}

// Stand in for each physical SignalR connection; the SDK itself supervises the
// geos, dispatches envelopes through App.use and encodes the frames returned.
function connections() {
  const pending: { handlers: SocketConnectionHandlers; ready(): void; fail(error: Error): void }[] = []
  vi.spyOn(SignalRSocketConnection.prototype, 'start').mockImplementation(function (this: SignalRSocketConnection, signal) {
    const { handlers } = this as unknown as { handlers: SocketConnectionHandlers }
    return new Promise<void>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
      pending.push({
        handlers,
        ready() { handlers.onReady({ botKey: config.appId }); resolve() },
        fail: reject,
      })
    })
  })
  return pending
}
afterEach(() => vi.restoreAllMocks())

it('returns native card responses and distinguishes durable receipt, duplicate receipt, rejection, and retry on the socket', async () => {
  const physical = connections()
  const accept = vi.fn<Parameters<typeof createTeamsSocket>[1]>()
  const socket = createTeamsSocket(config, accept)
  try {
    const startup = socket.start()
    expect(socket.start()).toBe(startup)
    await vi.waitFor(() => expect(physical).toHaveLength(3))
    expect(socket.isReady()).toBe(false)
    for (const connection of physical) connection.ready()
    await startup
    expect(socket.isReady()).toBe(true)
    const dispatch = physical[0].handlers.onActivity
    for (const [outcome, status] of [['accepted', 200], ['duplicate', 200], ['rejected', 403], ['retry', 503]] as const) {
      accept.mockResolvedValueOnce(outcome)
      const frame = await dispatch({ envelopeId: 'delivery-1', payload: message, ackRequired: true })
      expect(frame).toMatchObject({ protocolVersion: 1, botKey: config.appId, status, envelopeId: 'delivery-1' })
      expect(frame).not.toHaveProperty('body')
    }
    const body = { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: { type: 'AdaptiveCard' } }
    const card = { ...message, type: 'invoke', name: 'adaptiveCard/action', value: { action: { type: 'Action.Execute' } } }
    accept.mockResolvedValueOnce({ status: 200, body })
    expect(await dispatch({ envelopeId: 'card-1', type: 'invoke', payload: card, ackRequired: true })).toMatchObject({ status: 200, body, envelopeId: 'card-1' })
    expect(accept).toHaveBeenLastCalledWith(card)
  } finally {
    await socket.stop()
  }
  expect(socket.isReady()).toBe(false)
})

it('uses per-geo readiness, exposes recovery, and refuses a foreign tenant before a connector event', async () => {
  const physical = connections()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const connector = new TeamsConnector(config)
  const received = vi.fn()
  connector.onEvent(received)
  try {
    const opened = connector.connect()
    await vi.waitFor(() => expect(physical).toHaveLength(3))
    expect(connector.isConnected()).toBe(false)
    physical.forEach(c => c.ready())
    await opened
    const badTenant = { ...message, conversation: { ...message.conversation, tenantId: config.appId } }
    expect(await physical[0].handlers.onActivity({ payload: badTenant })).toMatchObject({ status: 403 })
    expect(received).not.toHaveBeenCalled()
    expect(connector.isConnected()).toBe(true)
    physical[0].handlers.onClosed()
    await vi.waitFor(() => expect(physical).toHaveLength(4))
    expect(connector.isConnected()).toBe(false)
    physical[3].ready()
    await vi.waitFor(() => expect(connector.isConnected()).toBe(true))
  } finally {
    await connector.disconnect()
  }
})

it('stops before SDK initialization completes without opening a late socket', async () => {
  const physical = connections()
  let finish!: () => void
  vi.spyOn(App.prototype, 'initialize').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const socket = createTeamsSocket(config, async () => 'accepted')
  const started = socket.start()
  const stopped = socket.stop()
  finish()
  await Promise.all([started, stopped])
  expect(physical).toHaveLength(0)
  expect(socket.isReady()).toBe(false)
})

it('reports the HTTP reason for a refused registration and keeps raw SDK credentials and errors out of the logs', async () => {
  const physical = connections()
  const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'debug'), vi.spyOn(console, 'info'), vi.spyOn(console, 'log')]
  for (const log of logs) log.mockImplementation(() => {})
  const socket = createTeamsSocket(config, async () => 'accepted')
  const started = socket.start()
  const failed = expect(started).rejects.toThrow('Microsoft Teams denied the development socket (HTTP 403)')
  await vi.waitFor(() => expect(physical).toHaveLength(3))
  physical[0].fail(new NegotiateError(`raw-request-with-${config.clientSecret}`, undefined, 403))
  await failed
  expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toContain(config.clientSecret)
  await socket.stop()
})
