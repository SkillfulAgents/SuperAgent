import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerLegacyFileRoutes } from './legacy-file-routes'
let root: string
let app: Hono
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'legacy-files-'))
  app = new Hono()
  registerLegacyFileRoutes(app, root)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.promises.rm(root, { recursive: true, force: true })
})
it('serves bytes through the legacy suffix, including encoded names', async () => {
  const name = 'hash#query?%.bin'
  const bytes = Buffer.from([0, 255, 2, 128])
  await fs.promises.writeFile(path.join(root, name), bytes)
  const response = await app.request(`/files/${encodeURIComponent(name)}/content`)
  expect(response.status).toBe(200)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
})
it('answers HEAD without opening a file or creating a stream', async () => {
  await fs.promises.writeFile(path.join(root, 'report.txt'), 'report')
  const open = vi.spyOn(fs.promises, 'open')
  const response = await app.request('/files/report.txt/content', { method: 'HEAD' })
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Length')).toBe('6')
  expect(await response.text()).toBe('')
  expect(open).not.toHaveBeenCalled()
})
it('lists and stats entries named content, including nested entries', async () => {
  await fs.promises.mkdir(path.join(root, 'content'))
  await fs.promises.writeFile(path.join(root, 'content', 'content'), 'data')
  const listing = await app.request('/files/content')
  expect(await listing.json()).toEqual([expect.objectContaining({ name: 'content', type: 'file' })])
  const metadata = await app.request('/files/content/content')
  expect(await metadata.json()).toMatchObject({ path: 'content/content', type: 'file', size: 4 })
  const bytes = await app.request('/files/content/content/content')
  expect(await bytes.text()).toBe('data')
})
it('uploads raw bytes through the legacy endpoint', async () => {
  const response = await app.request('/files/folder/report.bin/upload', { method: 'POST', body: new Uint8Array([0, 255, 1]) })
  expect(response.status).toBe(200)
  expect(await fs.promises.readFile(path.join(root, 'folder/report.bin'))).toEqual(Buffer.from([0, 255, 1]))
})
