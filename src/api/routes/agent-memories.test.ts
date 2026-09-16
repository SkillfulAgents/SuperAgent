import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { InMemoryFileOps } from '@shared/lib/agent-actor/testing/in-memory-file-ops'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { AGENT_MEMORY_DIR } from '@shared/lib/agent-actor/memory-schema'
import { createMemoryOps } from '@shared/lib/agent-actor/memory-ops'
import type { MemoryOps } from '@shared/lib/agent-actor/types'

let files: InMemoryFileOps
let memories: MemoryOps
const get = vi.fn((_slug: string) => ({ memories }))
vi.mock('@shared/lib/agent-actor', async () => ({
  ...await import('@shared/lib/agent-actor/memory-schema'),
  agentRegistry: { get: (slug: string) => get(slug) },
  get WorkspaceFileError() { return WorkspaceFileError },
}))
vi.mock('../middleware/auth', () => ({
  AgentAdmin: () => async (c: any, next: () => Promise<void>) => {
    if (c.req.header('x-test-role') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    return next()
  },
  getAgentId: () => 'resolved-agent-slug',
}))
import { agentMemoryRoutes } from './agent-memories'

const app = new Hono().route('/api/agents', agentMemoryRoutes)
const url = '/api/agents/display-name/memories'
const headers = { 'x-test-role': 'admin', 'Content-Type': 'application/json' }

beforeEach(() => {
  files = new InMemoryFileOps()
  memories = createMemoryOps(files)
  get.mockClear()
})

describe('memory API', () => {
  it('lists and edits through the resolved actor, preserving conflict responses', async () => {
    await files.putDoc(`${AGENT_MEMORY_DIR}/example.md`, '# Original')
    const listMemory = vi.spyOn(memories, 'list')
    const readMemory = vi.spyOn(memories, 'read')
    const saveMemory = vi.spyOn(memories, 'save')
    const list = await app.request(url, { headers })
    expect(list.status).toBe(200)
    expect(list.headers.get('Cache-Control')).toBe('no-store')
    expect(get).toHaveBeenCalledWith('resolved-agent-slug')
    expect(listMemory).toHaveBeenCalledOnce()
    const doc = await (await app.request(`${url}/content?path=example.md`, { headers })).json()
    const body = JSON.stringify({ path: 'example.md', content: '---\nname: Example\ndescription: Example memory\nmetadata:\n  type: project\n---\n# Edited', revision: doc.revision })
    expect((await app.request(`${url}/content`, { method: 'PUT', headers, body })).status).toBe(200)
    const conflict = await app.request(`${url}/content`, { method: 'PUT', headers, body })
    expect(conflict.status).toBe(409)
    expect(readMemory).toHaveBeenCalledWith('example.md')
    expect(saveMemory).toHaveBeenCalledWith('example.md', expect.any(String), doc.revision)
    expect(await conflict.json()).toMatchObject({ error: expect.stringContaining('changed') })
  })

  it.each(['', '/content?path=example.md'])('denies non-admin reads before actor access (%s)', async suffix => {
    expect((await app.request(url + suffix)).status).toBe(403)
    expect(get).not.toHaveBeenCalled()
  })

  it('denies non-admin writes before actor access', async () => {
    expect((await app.request(url + '/content', { method: 'PUT', body: '{}' })).status).toBe(403)
    expect(get).not.toHaveBeenCalled()
  })

  it('validates revisions and paths', async () => {
    expect((await app.request(url + '/content', { method: 'PUT', headers, body: JSON.stringify({ path: 'example.md', content: 'draft' }) })).status).toBe(400)
    expect((await app.request(url + '/content?path=..%2Fprivate.md', { headers })).status).toBe(400)
    expect((await app.request(url + '/content?path=missing.md', { headers })).status).toBe(404)
  })
  it('returns a helpful validation error and leaves stored content untouched', async () => {
    await files.putDoc(`${AGENT_MEMORY_DIR}/example.md`, '# Existing memory')
    const doc = await (await app.request(`${url}/content?path=example.md`, { headers })).json()
    const write = vi.spyOn(files, 'putDoc')
    const result = await app.request(`${url}/content`, {
      method: 'PUT', headers,
      body: JSON.stringify({ path: 'example.md', content: '---\nname: Example\n---\nBody', revision: doc.revision }),
    })
    expect(result.status).toBe(422)
    expect(await result.json()).toEqual({ error: 'Frontmatter "description" must be non-empty text.' })
    expect(write).not.toHaveBeenCalled()
    expect(new TextDecoder().decode(await files.getDoc(`${AGENT_MEMORY_DIR}/example.md`) ?? undefined)).toBe('# Existing memory')
  })

})
