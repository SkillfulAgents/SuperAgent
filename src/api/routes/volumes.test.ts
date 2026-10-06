import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockValidateProxyToken = vi.fn()
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...a: unknown[]) => mockValidateProxyToken(...a),
}))

// A test can stand in its own volume; otherwise the real lookup runs.
const mockVolume = vi.hoisted(() => ({ ops: null as BaseMountableVolume<unknown> | null }))
vi.mock('@shared/lib/services/mount-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/services/mount-service')>()
  return { ...actual, resolveVolume: (agentSlug: string, volumeId: string) => mockVolume.ops ?? actual.resolveVolume(agentSlug, volumeId) }
})

import { addMount } from '@shared/lib/services/mount-service'
import type { BaseMountableVolume, VolumeFile } from '@shared/lib/volumes/base-mountable-volume'
import volumes from './volumes'

function volumeReading(file: VolumeFile): BaseMountableVolume<unknown> {
  return { id: 'stand-in', name: 'stand-in', type: 'local', config: null, mountPath: '/mounts/stand-in', hostPath: null, list: vi.fn(), stat: vi.fn(), read: vi.fn(async () => file), write: vi.fn(), delete: vi.fn(), mkdir: vi.fn(), move: vi.fn() }
}

function request(url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const app = new Hono()
  app.route('/api/volumes', volumes)
  return app.request(`http://localhost/api/volumes/${url}`, {
    ...init,
    headers: { Authorization: 'Bearer good', ...init.headers },
  })
}

describe('/api/volumes', () => {
  let tmpDir: string
  let folder: string
  let volumeId: string

  beforeEach(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volumes-route-')))
    process.env.SUPERAGENT_DATA_DIR = tmpDir
    folder = path.join(tmpDir, 'notes')
    fs.mkdirSync(folder)
    fs.writeFileSync(path.join(folder, 'a.txt'), 'hello world')
    volumeId = (await addMount('agent-a', 'local', { path: folder })).id
    mockValidateProxyToken.mockResolvedValue('agent-a')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.SUPERAGENT_DATA_DIR
  })

  it('401s without a token, and 403s a volume attached to another agent', async () => {
    expect((await request(`${volumeId}/`, { method: 'PROPFIND', headers: { Authorization: '', Depth: '0' } })).status).toBe(401)
    mockValidateProxyToken.mockResolvedValue('agent-b')
    expect((await request(`${volumeId}/`, { method: 'PROPFIND', headers: { Depth: '0' } })).status).toBe(403)
  })

  it('403s a row of the agent of a type this version does not know', async () => {
    const file = path.join(tmpDir, 'agents', 'agent-a', 'mounts.json')
    fs.writeFileSync(file, JSON.stringify([...JSON.parse(fs.readFileSync(file, 'utf-8')), { id: 'drive', name: 'drive', type: 'not-a-type', config: {} }]))
    expect((await request('drive/', { method: 'PROPFIND', headers: { Depth: '0' } })).status).toBe(403)
  })

  it('lists the folder with PROPFIND and reads a file whole and by range', async () => {
    const listing = await request(`${volumeId}/`, { method: 'PROPFIND', headers: { Depth: '1' } })
    expect(listing.status).toBe(207)
    expect(await listing.text()).toContain(`<d:href>/api/volumes/${volumeId}/a.txt</d:href>`)
    expect(await (await request(`${volumeId}/a.txt`)).text()).toBe('hello world')
    const part = await request(`${volumeId}/a.txt`, { headers: { Range: 'bytes=6-10' } })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('world')
  })

  it('answers the paths rclone probes: missing 404, a missing parent 409, a folder read 404, bad paths 400', async () => {
    expect((await request(`${volumeId}/nope.txt`, { method: 'PROPFIND', headers: { Depth: '0' } })).status).toBe(404)
    expect((await request(`${volumeId}/no/such`, { method: 'MKCOL' })).status).toBe(409)
    expect((await request(`${volumeId}/no/such/b.txt`, { method: 'PUT', body: 'x' })).status).toBe(409)
    expect((await request(`${volumeId}/a.txt/b.txt`, { method: 'PUT', body: 'x' })).status).toBe(409)
    expect(fs.existsSync(path.join(folder, 'no'))).toBe(false)
    fs.mkdirSync(path.join(folder, 'sub'))
    expect((await request(`${volumeId}/sub`)).status).toBe(404)
    expect((await request(`${volumeId}/%E0%A4%A`)).status).toBe(400)
    expect((await request(`${volumeId}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(400)
  })

  it('answers HEAD with the size and no body, and an unsatisfiable range with 416', async () => {
    const head = await request(`${volumeId}/a.txt`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('11')
    expect(await head.text()).toBe('')
    const past = await request(`${volumeId}/a.txt`, { headers: { Range: 'bytes=20-30' } })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */11')
  })

  it('closes the opened file when it sends no body: HEAD, 416, and an empty file', async () => {
    const close = vi.fn(async () => {})
    const stream = vi.fn()
    try {
      mockVolume.ops = volumeReading({ size: 11, stream, close })
      await request(`${volumeId}/a.txt`, { method: 'HEAD' })
      expect(close).toHaveBeenCalledTimes(1)
      await request(`${volumeId}/a.txt`, { headers: { Range: 'bytes=20-30' } })
      expect(close).toHaveBeenCalledTimes(2)
      mockVolume.ops = volumeReading({ size: 0, stream, close })
      expect((await request(`${volumeId}/empty.txt`)).status).toBe(200)
      expect(close).toHaveBeenCalledTimes(3)
      expect(stream).not.toHaveBeenCalled()
    } finally {
      mockVolume.ops = null
    }
  })

  it('bounds a whole-file read to the size it advertised', async () => {
    const stream = vi.fn(() => new Blob(['hello world']).stream())
    try {
      mockVolume.ops = volumeReading({ size: 11, stream, close: vi.fn(async () => {}) })
      expect(await (await request(`${volumeId}/a.txt`)).text()).toBe('hello world')
      expect(stream).toHaveBeenCalledWith({ start: 0, end: 10 })
    } finally {
      mockVolume.ops = null
    }
  })

  it('answers 403 at the volume root once its folder is gone, and never makes it again', async () => {
    fs.rmSync(folder, { recursive: true })
    expect((await request(`${volumeId}/`, { method: 'PROPFIND', headers: { Depth: '0' } })).status).toBe(403)
    expect((await request(`${volumeId}/`)).status).toBe(403)
    expect((await request(`${volumeId}/`, { method: 'MKCOL' })).status).toBe(403)
    expect((await request(`${volumeId}/`, { method: 'PUT', body: 'x' })).status).toBe(403)
    expect((await request(`${volumeId}/`, { method: 'DELETE' })).status).toBe(403)
    expect((await request(`${volumeId}/`, { method: 'MOVE', headers: { Destination: `http://localhost/api/volumes/${volumeId}/x` } })).status).toBe(403)
    expect(fs.existsSync(folder)).toBe(false)
  })

  it('never makes, removes, moves or replaces the volume root', async () => {
    const to = (dest: string) => ({ Destination: `http://localhost/api/volumes/${volumeId}/${dest}` })
    expect((await request(`${volumeId}/`, { method: 'MKCOL' })).status).toBe(400)
    expect((await request(`${volumeId}/`, { method: 'PUT', body: 'x' })).status).toBe(400)
    expect((await request(`${volumeId}/`, { method: 'DELETE' })).status).toBe(400)
    expect((await request(`${volumeId}/`, { method: 'MOVE', headers: to('elsewhere') })).status).toBe(400)
    expect((await request(`${volumeId}/a.txt`, { method: 'MOVE', headers: to('') })).status).toBe(400)
    expect(fs.readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('hello world')
    expect(fs.statSync(folder).isDirectory()).toBe(true)
  })

  it('writes, makes a folder, moves into it, and deletes, on the real folder', async () => {
    expect((await request(`${volumeId}/b.txt`, { method: 'PUT', body: 'new' })).status).toBe(201)
    expect((await request(`${volumeId}/d`, { method: 'MKCOL' })).status).toBe(201)
    expect((await request(`${volumeId}/d`, { method: 'MKCOL' })).status).toBe(405)
    const destination = `http://localhost/api/volumes/${volumeId}/d/b.txt`
    expect((await request(`${volumeId}/b.txt`, { method: 'MOVE', headers: { Destination: destination } })).status).toBe(201)
    expect(fs.readFileSync(path.join(folder, 'd', 'b.txt'), 'utf8')).toBe('new')
    expect((await request(`${volumeId}/d`, { method: 'DELETE' })).status).toBe(409)
    expect((await request(`${volumeId}/d/b.txt`, { method: 'DELETE' })).status).toBe(204)
    expect(fs.existsSync(path.join(folder, 'd', 'b.txt'))).toBe(false)
  })

  it('answers a write onto a folder 405, a move into a missing folder 409, and a move onto a file replaces it', async () => {
    fs.mkdirSync(path.join(folder, 'd'))
    expect((await request(`${volumeId}/d`, { method: 'PUT', body: 'x' })).status).toBe(405)
    const into = (to: string) => ({ Destination: `http://localhost/api/volumes/${volumeId}/${to}` })
    expect((await request(`${volumeId}/a.txt`, { method: 'MOVE', headers: into('no/a.txt') })).status).toBe(409)
    fs.writeFileSync(path.join(folder, 'b.txt'), 'old')
    expect((await request(`${volumeId}/a.txt`, { method: 'MOVE', headers: { ...into('b.txt'), Overwrite: 'T' } })).status).toBe(201)
    expect(fs.readFileSync(path.join(folder, 'b.txt'), 'utf8')).toBe('hello world')
  })
})
