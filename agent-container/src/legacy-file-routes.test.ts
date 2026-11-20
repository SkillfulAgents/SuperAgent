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
it('serves one byte range as 206 with only those bytes', async () => {
  await fs.promises.writeFile(path.join(root, 'session.jsonl'), 'first line\nsecond line\n')
  const middle = await app.request('/files/session.jsonl/content', { headers: { Range: 'bytes=6-9' } })
  expect(middle.status).toBe(206)
  expect(middle.headers.get('Content-Range')).toBe('bytes 6-9/23')
  expect(middle.headers.get('Content-Length')).toBe('4')
  expect(await middle.text()).toBe('line')
  const tail = await app.request('/files/session.jsonl/content', { headers: { Range: 'bytes=-5' } })
  expect(tail.headers.get('Content-Range')).toBe('bytes 18-22/23')
  expect(await tail.text()).toBe('line\n')
  const rest = await app.request('/files/session.jsonl/content', { headers: { Range: 'bytes=11-100' } })
  expect(rest.headers.get('Content-Range')).toBe('bytes 11-22/23')
  expect(await rest.text()).toBe('second line\n')
})
it('refuses a range that starts past the end with 416 and the file size', async () => {
  await fs.promises.writeFile(path.join(root, 'report.txt'), 'report')
  const response = await app.request('/files/report.txt/content', { headers: { Range: 'bytes=6-' } })
  expect(response.status).toBe(416)
  expect(response.headers.get('Content-Range')).toBe('bytes */6')
})
it('serves the whole file when the range has a form it does not serve', async () => {
  await fs.promises.writeFile(path.join(root, 'report.txt'), 'report')
  const response = await app.request('/files/report.txt/content', { headers: { Range: 'bytes=0-1,3-4' } })
  expect(response.status).toBe(200)
  expect(response.headers.get('Accept-Ranges')).toBe('bytes')
  expect(await response.text()).toBe('report')
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
it('creates a folder, nested ones too, and its missing parents', async () => {
  const nested = await app.request('/files/.claude/skills/dream/mkdir', { method: 'POST' })
  expect(nested.status).toBe(200)
  expect(await nested.json()).toEqual({ success: true, path: '.claude/skills/dream' })
  expect((await fs.promises.stat(path.join(root, '.claude/skills/dream'))).isDirectory()).toBe(true)
  const top = await app.request('/files/notes/mkdir', { method: 'POST' })
  expect(top.status).toBe(200)
  expect((await fs.promises.stat(path.join(root, 'notes'))).isDirectory()).toBe(true)
  // Again: a folder that exists is not an error.
  expect((await app.request('/files/notes/mkdir', { method: 'POST' })).status).toBe(200)
})
it('refuses to create a folder outside the workspace', async () => {
  const response = await app.request(`/files/${encodeURIComponent('../outside')}/mkdir`, { method: 'POST' })
  expect([400, 403]).toContain(response.status)
  expect(fs.existsSync(path.join(root, '../outside'))).toBe(false)
})
it('keeps the mode an upload asks for, and a rewrite without one keeps it', async () => {
  const upload = (body: string, query = '') => app.request(`/files/bin/tool/upload${query}`, { method: 'POST', body })
  expect((await upload('#!/bin/sh\n', '?mode=0755')).status).toBe(200)
  expect(await (await app.request('/files/bin/tool')).json()).toMatchObject({ type: 'file', mode: 0o755 })
  expect((await upload('#!/bin/sh\necho hi\n')).status).toBe(200)
  expect(await (await app.request('/files/bin/tool')).json()).toMatchObject({ size: 18, mode: 0o755 })
  expect((await upload('x', '?mode=rwx')).status).toBe(400)
})
it('refuses a write over a folder or through a file with 409 and a code, not 500', async () => {
  await fs.promises.mkdir(path.join(root, 'notes'))
  await fs.promises.writeFile(path.join(root, 'report.txt'), 'report')
  const cases: Array<[string, string]> = [
    ['/files/notes/upload', 'not-a-file'],
    ['/files/report.txt/child/upload', 'not-a-directory'],
    ['/files/report.txt/child/leaf/upload', 'not-a-directory'],
    ['/files/report.txt/child/mkdir', 'not-a-directory'],
    ['/files/report.txt/mkdir', 'not-a-directory'],
  ]
  for (const [url, code] of cases) {
    const response = await app.request(url, { method: 'POST', body: 'x' })
    expect([url, response.status]).toEqual([url, 409])
    expect(await response.json()).toMatchObject({ code })
  }
  expect(await fs.promises.readFile(path.join(root, 'report.txt'), 'utf8')).toBe('report')
})
