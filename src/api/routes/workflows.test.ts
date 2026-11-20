import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import * as path from 'path'

const FIXTURE_ROOT = path.join(
  __dirname,
  '..',
  '..',
  'shared',
  'lib',
  'container',
  '__fixtures__',
  'local-workflow-capture-probe'
)
const SID = 'd63a9cbc-2f5e-44dd-8017-231ac99bef35'
const RUN = 'wf_818f758a-c17'

// Auth is a passthrough; the fixture is the agent's workspace and its
// transcripts directory at once, so the routes read genuine on-disk workflow
// artifacts through the agent's file operations. getAgentId reads what the
// resolver in app() stashed, as ResolveAgent does.
vi.mock('../middleware/auth', () => ({
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getAgentId: (c: { get: (key: string) => string }) => c.get('agentId'),
}))
vi.mock('@shared/lib/agent-actor/session-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/agent-actor/session-store')>()),
  CLI_TRANSCRIPTS_DIR: '',
}))
const workspaceRoot = { value: FIXTURE_ROOT }
vi.mock('@shared/lib/utils/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/utils/file-storage')>()
  return {
    ...actual,
    // Only the canonical id has the fixture: a display slug opens nothing.
    getAgentWorkspaceDir: (slug: string) => (slug === 'my-agent' ? workspaceRoot.value : path.join(workspaceRoot.value, 'missing', slug)),
  }
})

import { workflowRoutes } from './workflows'

// The display slug `research-bot` names the agent `my-agent`.
function app() {
  const a = new Hono()
  a.use('/api/agents/:id/*', async (c, next) => {
    c.set('agentId' as never, (c.req.param('id') === 'research-bot' ? 'my-agent' : c.req.param('id')) as never)
    await next()
  })
  a.route('/api/agents', workflowRoutes)
  return a
}

const get = (url: string) => app().request(`http://localhost${url}`)

describe('workflow tree route', () => {
  it('returns the joined per-agent tree for a real run', async () => {
    const res = await get(`/api/agents/my-agent/sessions/${SID}/workflows/${RUN}/tree`)
    expect(res.status).toBe(200)
    const tree = await res.json()
    expect(tree.name).toBe('capture-probe')
    expect(tree.phases.map((p: { title: string }) => p.title)).toEqual(['Scan', 'Summarize'])
    expect(tree.agents).toHaveLength(3)
    const concat = tree.agents.find((a: { label: string }) => a.label === 'concat')
    expect(concat).toMatchObject({ phase: 'Summarize', status: 'done', result: 'alpha-beta' })
  })

  it('404s for an unknown run', async () => {
    const res = await get(`/api/agents/my-agent/sessions/${SID}/workflows/wf_nope/tree`)
    expect(res.status).toBe(404)
  })

  it('400s on a traversal-shaped runId', async () => {
    const res = await get(`/api/agents/my-agent/sessions/${SID}/workflows/wf_..%2f..%2fetc/tree`)
    expect(res.status).toBe(400)
  })

  it('400s on a non-wf runId', async () => {
    const res = await get(`/api/agents/my-agent/sessions/${SID}/workflows/evil/tree`)
    expect(res.status).toBe(400)
  })
})

describe('workflow agent-messages route', () => {
  it('returns the transcript for a workflow subagent', async () => {
    const res = await get(
      `/api/agents/my-agent/sessions/${SID}/workflows/${RUN}/agents/ae6ffae379942dd19/messages`
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(body)).toContain('alpha')
  })

  it('returns a large transcript parse-identically', async () => {
    const os = await import('os')
    const fs = await import('fs')
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wf-large-'))
    const runDir = path.join(tmpRoot, SID, 'subagents', 'workflows', RUN)
    await fs.promises.mkdir(runDir, { recursive: true })
    const lines = Array.from({ length: 800 }, (_, i) =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: true,
        agentId: 'bigagent',
        type: 'user',
        message: { role: 'user', content: `entry ${i} ${'x'.repeat(200)}` },
        uuid: `uuid-${i}`,
        timestamp: '2026-06-23T20:00:23.404Z',
      })
    )
    await fs.promises.writeFile(path.join(runDir, 'agent-bigagent.jsonl'), lines.join('\n'))

    const previousDir = workspaceRoot.value
    workspaceRoot.value = tmpRoot
    try {
      const res = await get(
        `/api/agents/my-agent/sessions/${SID}/workflows/${RUN}/agents/bigagent/messages`
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveLength(800)
      expect(body[0].content.text).toContain('entry 0')
      expect(body[799].content.text).toContain('entry 799')
    } finally {
      workspaceRoot.value = previousDir
      await fs.promises.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('serves the same items as a trailing page, and a delta after the first one', async () => {
    const url = `/api/agents/my-agent/sessions/${SID}/workflows/${RUN}/agents/ae6ffae379942dd19/messages`
    const whole = await (await get(url)).json()

    const res = await get(`${url}?limit=300&media=ref`)
    expect(res.status).toBe(200)
    const page = await res.json()
    expect(page.messages.map((item: { id: string }) => item.id)).toEqual(whole.map((item: { id: string }) => item.id))
    expect(page.nextCursor).toBeNull()

    const delta = await (await get(`${url}?after=${page.messages[0].id}&media=ref`)).json()
    expect(delta.resync).toBeUndefined()
    expect(delta.messages.length).toBeGreaterThanOrEqual(1)
  })

  it('reads the transcript of the agent a display slug resolves to', async () => {
    const route = `sessions/${SID}/workflows/${RUN}/agents/ae6ffae379942dd19/messages?limit=300&media=ref`
    const canonical = await (await get(`/api/agents/my-agent/${route}`)).json()
    expect(canonical.messages.length).toBeGreaterThan(0)

    const res = await get(`/api/agents/research-bot/${route}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(canonical)
  })

  it('serves an empty page for a valid-but-missing agent id', async () => {
    const res = await get(
      `/api/agents/my-agent/sessions/${SID}/workflows/${RUN}/agents/doesnotexist/messages?limit=300`
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messages: [], nextCursor: null })
  })

  it('returns [] for a valid-but-missing agent id (no 500)', async () => {
    const res = await get(
      `/api/agents/my-agent/sessions/${SID}/workflows/${RUN}/agents/doesnotexist/messages`
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('400s on a malformed agent id', async () => {
    const res = await get(
      `/api/agents/my-agent/sessions/${SID}/workflows/${RUN}/agents/bad.id/messages`
    )
    expect(res.status).toBe(400)
  })
})
