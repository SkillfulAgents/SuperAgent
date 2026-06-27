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

// Auth is a passthrough; getAgentSessionsDir points at the real fixture so the
// routes read genuine on-disk workflow artifacts (readJsonlFile stays real).
const mockSessionsDir = { value: FIXTURE_ROOT }
vi.mock('../middleware/auth', () => ({
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))
vi.mock('@shared/lib/utils/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/utils/file-storage')>()
  return { ...actual, getAgentSessionsDir: () => mockSessionsDir.value }
})

import { workflowRoutes } from './workflows'

function app() {
  const a = new Hono()
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
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(body)).toContain('alpha')
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
