import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { VolumeError } from '@shared/lib/volumes/volume-error'

const { browse, create, validate } = vi.hoisted(() => ({ browse: vi.fn(), create: vi.fn(), validate: vi.fn() }))
vi.mock('@shared/lib/volumes/volume-factory', () => ({ browseVolumeFolders: browse, createVolumeFolder: create, validateVolumeSource: validate }))
vi.mock('../middleware/auth', () => ({
  Authenticated: (): MiddlewareHandler => async (c, next) => {
    const id = c.req.header('Test-User')
    if (!id) return c.json({ error: 'Unauthorized' }, 401)
    c.set('user' as never, { id, role: 'user' } as never)
    return next()
  },
}))
import routes from './volume-types'
const app = new Hono().route('/api/volume-types', routes)
const request = () => app.request('/api/volume-types/example/folders?accountId=account&folder=%2FTeam', { headers: { 'Test-User': 'alice' } })
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('AUTH_MODE', 'true') })
afterEach(() => vi.unstubAllEnvs())

describe('volume type setup API', () => {
  it('requires authentication and dispatches any type with the authenticated viewer and its query', async () => {
    expect((await app.request('/api/volume-types/example/folders')).status).toBe(401)
    expect(browse).not.toHaveBeenCalled()
    browse.mockResolvedValue({ folders: [{ id: '/Team/Sub', name: 'Sub' }] })
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ folders: [{ id: '/Team/Sub', name: 'Sub' }] })
    expect(browse).toHaveBeenCalledWith('example', { accountId: 'account', folder: '/Team' }, { userId: 'alice', admin: false })
  })

  it.each([
    new VolumeError('Unknown source', 404),
    new WorkspaceFileError('not-found'),
    new WorkspaceFileError('not-accessible'),
    new VolumeError('Source unavailable', 503),
  ])('preserves source errors without provider-specific handlers', async error => {
    browse.mockRejectedValue(error)
    const response = await request()
    expect(response.status).toBe(error.status)
    expect(await response.json()).toEqual({ error: error.message })
  })

  it('forwards Retry-After and distinguishes invalid input from an unavailable source', async () => {
    browse.mockRejectedValueOnce(new VolumeError('Source is busy', 429, 60))
    const busy = await request()
    expect(busy.status).toBe(429)
    expect(busy.headers.get('Retry-After')).toBe('60')
    const invalid = z.object({ accountId: z.string() }).safeParse({})
    if (invalid.success) throw new Error('Expected invalid input')
    browse.mockRejectedValueOnce(invalid.error)
    expect((await request()).status).toBe(400)
    browse.mockRejectedValueOnce(new Error('private upstream details'))
    const unavailable = await request()
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ error: 'The drive source is temporarily unavailable. Please try again.' })
  })
})


describe('source connection validation', () => {
  it('authenticates and dispatches credentials in the POST body, never the URL', async () => {
    const url = '/api/volume-types/s3/validate'
    expect((await app.request(url, { method: 'POST' })).status).toBe(401)
    expect(validate).not.toHaveBeenCalled()
    const result = { valid: false, checks: [{ label: 'Read objects', status: 'failed', message: 'No read permission' }], warnings: [] }
    validate.mockResolvedValue(result)
    const input = { bucket: 'example', credentials: { accessKeyId: 'key', secretAccessKey: 'secret' } }
    const response = await app.request(url, { method: 'POST', headers: { 'Test-User': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
    expect(validate).toHaveBeenCalledWith('s3', input, { userId: 'alice', admin: false })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})

describe('setup folder creation', () => {
  it('authenticates and dispatches the JSON body with the viewer to the type', async () => {
    const url = '/api/volume-types/example/folders'
    const init = { method: 'POST', body: JSON.stringify({ accountId: 'account', folderId: 'parent', name: 'Scratch' }) }
    expect((await app.request(url, init)).status).toBe(401)
    expect(create).not.toHaveBeenCalled()
    create.mockResolvedValue({ folder: { id: 'made', name: 'Scratch' } })
    const response = await app.request(url, { ...init, headers: { 'Test-User': 'alice' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ folder: { id: 'made', name: 'Scratch' } })
    expect(create).toHaveBeenCalledWith('example', { accountId: 'account', folderId: 'parent', name: 'Scratch' }, { userId: 'alice', admin: false })
    const invalid = z.object({ name: z.string() }).safeParse({})
    if (invalid.success) throw new Error('Expected invalid input')
    create.mockRejectedValueOnce(invalid.error)
    const rejected = await app.request(url, { ...init, headers: { 'Test-User': 'alice' } })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'Invalid new folder details' })
    const calls = create.mock.calls.length
    const malformed = await app.request(url, { method: 'POST', body: '{', headers: { 'Test-User': 'alice' } })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Invalid new folder details' })
    expect(create).toHaveBeenCalledTimes(calls)
  })
})
