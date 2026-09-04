import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'

vi.mock('../middleware/auth', () => {
  const passthrough: MiddlewareHandler = async (_c, next) => next()
  return {
    Authenticated: () => passthrough,
    AgentUser: () => passthrough,
    ResolveAgent: () => passthrough,
  }
})

const { mockGetCurrentUserId, mockCreate, mockList, mockDelete, mockAttach, mockDetach } = vi.hoisted(() => ({
  mockGetCurrentUserId: vi.fn(() => 'user-1'),
  mockCreate: vi.fn(),
  mockList: vi.fn((): Array<{ id: string; name: string; mountName: string; attachedAgents: { slug: string; name: string }[] }> => []),
  mockDelete: vi.fn(),
  mockAttach: vi.fn(),
  mockDetach: vi.fn(),
}))
vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => mockGetCurrentUserId(),
}))

const mockLogAuditEvent = vi.fn()
vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}))

vi.mock('@shared/lib/services/shared-volume-service', () => ({
  SharedVolumeError: class SharedVolumeError extends Error {
    constructor(
      message: string,
      public status: 400 | 404 | 409,
    ) {
      super(message)
      this.name = 'SharedVolumeError'
    }
  },
  createSharedVolume: mockCreate,
  listSharedVolumes: mockList,
  deleteSharedVolume: mockDelete,
  attachSharedVolume: mockAttach,
  detachSharedVolume: mockDetach,
}))

import volumes from './volumes'
import { SharedVolumeError } from '@shared/lib/services/shared-volume-service'
import { sharedVolumeListResponseSchema } from '@shared/lib/services/mount-schema'

function createApp() {
  const app = new Hono()
  app.route('/api/volumes', volumes)
  return app
}

describe('GET /api/volumes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockReturnValue([])
  })

  it('returns the registry list', async () => {
    mockList.mockReturnValue([{ id: 'vol-1', name: 'Notes', mountName: 'notes', attachedAgents: [] }])
    const res = await createApp().request('http://localhost/api/volumes')
    expect(res.status).toBe(200)
    expect(sharedVolumeListResponseSchema.parse(await res.json())).toEqual({
      volumes: [{ id: 'vol-1', name: 'Notes', mountName: 'notes', attachedAgents: [] }],
    })
  })
})

describe('POST /api/volumes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreate.mockResolvedValue({
      id: 'vol-1',
      name: 'Team Brain',
      mountName: 'team-brain',
      createdAt: new Date('2026-08-31'),
    })
  })

  it('creates a volume and writes an audit row', async () => {
    const res = await createApp().request('http://localhost/api/volumes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Team Brain' }),
    })
    expect(res.status).toBe(201)
    expect(mockCreate).toHaveBeenCalledWith('Team Brain')
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ object: 'volume', objectId: 'vol-1', action: 'created' }),
    )
  })

  it('returns 400 on a duplicate name', async () => {
    mockCreate.mockRejectedValueOnce(new SharedVolumeError('A shared volume with this name already exists', 400))
    const res = await createApp().request('http://localhost/api/volumes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Team Brain' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'A shared volume with this name already exists' })
  })

  it('returns 400 on an empty name', async () => {
    const res = await createApp().request('http://localhost/api/volumes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/volumes/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDelete.mockResolvedValue(undefined)
  })

  it('surfaces the delete-guard 409', async () => {
    mockDelete.mockRejectedValueOnce(new SharedVolumeError('Volume is attached to other agents', 409))
    const res = await createApp().request('http://localhost/api/volumes/vol-1', { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Volume is attached to other agents' })
  })
})
