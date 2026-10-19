import { describe, expect, it, vi } from 'vitest'
import type { MiddlewareHandler } from 'hono'

const update = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('../middleware/auth', () => ({ Authenticated: (): MiddlewareHandler => async (_c, next) => next() }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'alice' }))
vi.mock('@shared/lib/voice', () => ({ getConfiguredVoiceProvider: () => null }))
vi.mock('@shared/lib/services/user-settings-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/services/user-settings-service')>(),
  updateUserSettings: update,
}))
import router from './user-settings'

describe('PUT /api/user-settings', () => {
  it('refuses drive defaults, which only the drive route may write', async () => {
    const res = await router.request('/', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ myAgentDrives: { drive: { level: 'write', shared: true } } }),
    })
    expect(res.status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })
})
