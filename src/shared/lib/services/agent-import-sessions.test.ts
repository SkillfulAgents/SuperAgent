/**
 * Restoring sessions from a full `.agent` import.
 *
 * A full import writes real transcripts and real `session-metadata.json` into
 * the new agent's workspace. From the user's point of view the imported agent
 * has those sessions, and opening it should list them.
 *
 * The tests marked `it.fails` are RED on main. They describe the behaviour the
 * product is supposed to have; the host-owned session ownership index does not
 * know about ids that arrive by any route other than session creation, so a
 * restored session is present on disk but filtered out of every listing.
 *
 * `it.fails` (rather than a plain failing test) keeps CI honest in both
 * directions: the suite is green while the bug exists, and it goes RED the
 * moment the bug is fixed without someone flipping these to `it`. The follow-up
 * that removes the ownership index flips them.
 *
 * Everything here is real: the template service, the session service, the
 * file-storage paths and the filesystem. Only agent creation is stubbed, so a
 * test can pin the slug.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import crypto from 'crypto'
import { createZipBuffer } from '@shared/lib/utils/zip'

vi.mock('@shared/lib/services/agent-service', () => ({
  createAgentFromExistingWorkspace: vi.fn(),
  getAgentWithStatus: vi.fn(),
  listAgents: vi.fn(async () => []),
}))

vi.mock('@shared/lib/services/skillset-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/services/skillset-service')>()
  return {
    ...actual,
    ensureSkillsetCached: vi.fn(),
    getSkillsetRepoDir: vi.fn((id: string) => `/tmp/mock-skillset-cache/${id}`),
    isCacheReady: vi.fn(async () => true),
    getSkillsetIndex: vi.fn(),
    readIndexJson: vi.fn(),
    refreshSkillset: vi.fn(),
    copyDirectory: vi.fn(),
  }
})

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveAnthropicApiKey: vi.fn(() => undefined),
  getEffectiveModels: vi.fn(() => ({ summarizerModel: 'claude-haiku-4-5-20251001' })),
}))
vi.mock('@shared/lib/utils/retry', () => ({ withRetry: async (fn: () => Promise<unknown>) => fn() }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAuthStatus: () => ({ orgId: undefined }),
  getPlatformAccessToken: vi.fn(() => undefined),
}))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: vi.fn(() => undefined) }))

import { importAgentFromTemplate } from './agent-template-service'
import { listSessions, registerSession, sessionIsKnown } from './session-service'
import { createAgentFromExistingWorkspace, getAgentWithStatus } from '@shared/lib/services/agent-service'
import { getAgentDir, getAgentSessionsDir, getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'

const MINIMAL_CLAUDE_MD = `---
name: Test Agent
createdAt: '2026-01-01T00:00:00.000Z'
---

An imported agent.
`

let tmpDir: string
let previousDataDir: string | undefined

beforeEach(async () => {
  vi.clearAllMocks()
  previousDataDir = process.env.SUPERAGENT_DATA_DIR
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-import-sessions-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir

  // Any install that has ever run a session already has host-side session
  // bookkeeping in place. That is the precondition under which an import is
  // normally performed, and — on main — the one under which restored sessions
  // go missing: a lazily-built index would otherwise sweep the imported
  // transcripts up on its first read and hide the bug.
  fs.mkdirSync(getAgentSessionsDir('pre-existing-agent'), { recursive: true })
  await registerSession('pre-existing-agent', crypto.randomUUID(), 'Pre-existing session')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = previousDataDir
})

/** Pin the slug the import will create, and prepare its workspace. */
function nextAgentIs(slug: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent = { slug, name: 'Test Agent' } as any
  vi.mocked(createAgentFromExistingWorkspace).mockResolvedValue(agent)
  vi.mocked(getAgentWithStatus).mockResolvedValue(agent)
  fs.mkdirSync(getAgentWorkspaceDir(slug), { recursive: true })
}

/** A full `.agent` archive carrying one session: metadata entry + transcript. */
function archiveWithSession(sessionId: string, name = 'Restored session'): Promise<Buffer> {
  return createZipBuffer({
    'CLAUDE.md': MINIMAL_CLAUDE_MD,
    'session-metadata.json': JSON.stringify({
      [sessionId]: { name, createdAt: '2026-08-28T12:00:00.000Z' },
    }),
    [`.claude/projects/-workspace/${sessionId}.jsonl`]: `${JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      sessionId,
      message: { role: 'user', content: 'Hello' },
    })}\n`,
  })
}

describe('full `.agent` import restores its sessions', () => {
  it.fails('lists a restored session on the imported agent', async () => {
    const sessionId = crypto.randomUUID()
    nextAgentIs('imported-agent')

    await importAgentFromTemplate(await archiveWithSession(sessionId), undefined, 'full')

    await expect(listSessions('imported-agent')).resolves.toEqual([
      expect.objectContaining({
        id: sessionId,
        agentSlug: 'imported-agent',
        name: 'Restored session',
      }),
    ])
  })

  it.fails('treats a restored session as a session of the imported agent', async () => {
    const sessionId = crypto.randomUUID()
    nextAgentIs('known-agent')

    await importAgentFromTemplate(await archiveWithSession(sessionId), undefined, 'full')

    expect(await sessionIsKnown('known-agent', sessionId)).toBe(true)
  })

  it.fails('restores the sessions again after the imported agent is deleted', async () => {
    // Export once, import, throw the agent away, import the same archive again.
    // Nothing about the archive changed, so the second import must behave
    // exactly like the first.
    const sessionId = crypto.randomUUID()
    const archive = await archiveWithSession(sessionId)

    nextAgentIs('first-import')
    await importAgentFromTemplate(archive, undefined, 'full')

    // What deleteAgent does to the host once the container is stopped.
    fs.rmSync(getAgentDir('first-import'), { recursive: true, force: true })

    nextAgentIs('second-import')
    await importAgentFromTemplate(archive, undefined, 'full')

    await expect(listSessions('second-import')).resolves.toEqual([
      expect.objectContaining({ id: sessionId, agentSlug: 'second-import' }),
    ])
  })

  it.fails('gives each agent its own copy when one archive is imported twice', async () => {
    // Importing the same export twice is how an agent gets cloned. The two
    // copies genuinely share session ids — they are copies of the same
    // transcripts — and each agent has to list its own.
    const sessionId = crypto.randomUUID()
    const archive = await archiveWithSession(sessionId)

    nextAgentIs('clone-one')
    await importAgentFromTemplate(archive, undefined, 'full')

    nextAgentIs('clone-two')
    await importAgentFromTemplate(archive, undefined, 'full')

    await expect(listSessions('clone-one')).resolves.toEqual([
      expect.objectContaining({ id: sessionId, agentSlug: 'clone-one' }),
    ])
    await expect(listSessions('clone-two')).resolves.toEqual([
      expect.objectContaining({ id: sessionId, agentSlug: 'clone-two' }),
    ])
  })
})

describe('an import never takes sessions away from an existing agent', () => {
  it('leaves the pre-existing agent’s own sessions listed', async () => {
    const sessionId = crypto.randomUUID()
    nextAgentIs('bystander-import')
    const before = await listSessions('pre-existing-agent')
    expect(before).toHaveLength(1)

    await importAgentFromTemplate(await archiveWithSession(sessionId), undefined, 'full')

    await expect(listSessions('pre-existing-agent')).resolves.toEqual(before)
  })

  it('leaves the pre-existing agent’s sessions listed when the import collides with one', async () => {
    // An archive whose transcript is named after a session that already exists
    // on this host. Whatever the import does with its own copy, the agent that
    // already had that session keeps it.
    const collidingId = (await listSessions('pre-existing-agent'))[0].id
    nextAgentIs('colliding-import')
    const before = await listSessions('pre-existing-agent')

    await importAgentFromTemplate(await archiveWithSession(collidingId), undefined, 'full')
      .catch(() => undefined)

    await expect(listSessions('pre-existing-agent')).resolves.toEqual(before)
    expect(await sessionIsKnown('pre-existing-agent', collidingId)).toBe(true)
  })
})
