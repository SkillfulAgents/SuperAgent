import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PasskeyKeeper, VirtualCredential } from './passkey-keeper'
import { registerPasskeyRoutes } from './passkey-routes'

const PASSKEY: VirtualCredential = { credentialId: 'Y3JlZC0x', rpId: 'github.com', privateKey: 'k'.repeat(160), signCount: 1, userName: 'octocat' }

const keeper = {
  arm: vi.fn(async () => {}),
  disarm: vi.fn(async () => {}),
  takeCreated: vi.fn(async (): Promise<VirtualCredential | null> => null),
  state: vi.fn(() => ({ armed: true, mode: 'present' as const, targetId: 't-1', credentialIds: ['Y3JlZC0x'], asserted: [], expiresAt: 1 })),
}
const deps = {
  hostAuthEnabled: vi.fn(() => true),
  validateSession: vi.fn((): string | null => null),
  browserActive: vi.fn(() => true),
  keeper: keeper as unknown as PasskeyKeeper,
  activeTab: vi.fn(async (): Promise<{ id: string; url: string } | null> => ({ id: 't-1', url: 'https://github.com/settings/security' })),
  click: vi.fn(async (): Promise<string | null> => null),
}

let app: Hono
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  app = new Hono()
  registerPasskeyRoutes(app, deps)
})

describe('passkey routes', () => {
  it('holds passkeys on the agent\'s tab, says the page\'s origin, and clicks what the host named after', async () => {
    const res = await post('/browser/passkey/arm', { sessionId: 's-1', mode: 'present', credentials: [PASSKEY], ttlMs: 300_000 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ armed: true, origin: 'https://github.com' })
    expect(keeper.arm).toHaveBeenCalledWith({ targetId: 't-1', mode: 'present', credentials: [PASSKEY], ttlMs: 300_000, keep: undefined })
    expect(deps.click).not.toHaveBeenCalled()

    deps.click.mockResolvedValueOnce("✗ Element '@e7' not found")
    const recording = await post('/browser/passkey/arm', { sessionId: 's-1', mode: 'record', ttlMs: 600_000, keep: true, clickRef: 'e7' })
    expect(await recording.json()).toEqual({ armed: true, origin: 'https://github.com', clickError: "✗ Element '@e7' not found" })
    expect(deps.click).toHaveBeenCalledWith('@e7')
  })

  it('refuses without host authentication, for another session, with no browser or no web page, and never echoes a body', async () => {
    deps.hostAuthEnabled.mockReturnValueOnce(false)
    expect((await post('/browser/passkey/arm', { sessionId: 's-1', mode: 'present', ttlMs: 300_000 })).status).toBe(503)
    deps.validateSession.mockReturnValueOnce('This browser belongs to another session')
    expect((await post('/browser/passkey/arm', { sessionId: 's-2', mode: 'present', ttlMs: 300_000 })).status).toBe(409)
    deps.browserActive.mockReturnValueOnce(false)
    expect((await post('/browser/passkey/arm', { sessionId: 's-1', mode: 'present', ttlMs: 300_000 })).status).toBe(409)
    deps.activeTab.mockResolvedValueOnce({ id: 't-1', url: 'about:blank' })
    expect((await post('/browser/passkey/arm', { sessionId: 's-1', mode: 'present', ttlMs: 300_000 })).status).toBe(409)
    const bad = await post('/browser/passkey/arm', { sessionId: 's-1', mode: 'present', ttlMs: 300_000, credentials: [{ ...PASSKEY, extra: PASSKEY.privateKey }] })
    expect(bad.status).toBe(400)
    expect(await bad.text()).not.toContain(PASSKEY.privateKey)
    expect(keeper.arm).not.toHaveBeenCalled()
  })

  it('hands over the passkey the page created, and says what the tab holds by id only', async () => {
    keeper.takeCreated.mockResolvedValueOnce(PASSKEY)
    expect(await (await post('/browser/passkey/created', { waitMs: 1_000 })).json()).toEqual({ credential: PASSKEY })
    expect(keeper.takeCreated).toHaveBeenCalledWith(1_000)
    expect(await (await post('/browser/passkey/created', { waitMs: 0 })).json()).toEqual({ credential: null })
    const state = await (await app.request('/browser/passkey/state')).text()
    expect(JSON.parse(state)).toMatchObject({ armed: true, credentialIds: ['Y3JlZC0x'], onActiveTab: true })
    deps.activeTab.mockResolvedValueOnce({ id: 't-2', url: 'https://github.com/login' })
    expect(await (await app.request('/browser/passkey/state')).json()).toMatchObject({ armed: true, onActiveTab: false })
    expect((await post('/browser/passkey/disarm', {})).status).toBe(200)
    expect(keeper.disarm).toHaveBeenCalled()
  })
})
