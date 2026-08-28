/**
 * The visible-session listing contract, pinned on a real filesystem.
 *
 * `GET /api/agents?include_latest_visible_session_tail=true` and
 * `GET /api/agents/:id/sessions` derive "latest visible session" and the
 * visible set from this listing. The route tests mock the service layer, so
 * these are the tests that hold the line on visibility, ownership, empty-file
 * and ordering rules when the listing's implementation changes (for example
 * to read from the session summary cache instead of statting every
 * transcript). Every case here must keep passing regardless of how the list
 * is produced.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SAMPLE_JSONL_ENTRIES, toJsonl } from './__fixtures__/test-data'
import {
  listSessions,
  listSessionsFromSummary,
  getSessionMessagesPage,
  reserveSessionOwnership,
} from './session-service'

// Both implementations must satisfy the same contract: listSessions stats
// every transcript; listSessionsFromSummary reads the summary cache. Each
// test seeds its own temp dir, so the cache starts cold and is built from the
// same directory state the stat-based listing sees.
describe.each([
  ['listSessions', listSessions],
  ['listSessionsFromSummary', listSessionsFromSummary],
] as const)('%s visible-list contract', (_name, list) => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-listing-test-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  const workspaceDir = (slug: string) => path.join(testDir, 'agents', slug, 'workspace')
  const sessionsDir = (slug: string) =>
    path.join(workspaceDir(slug), '.claude', 'projects', '-workspace')
  const transcriptPath = (slug: string, id: string) => path.join(sessionsDir(slug), `${id}.jsonl`)

  async function writeTranscript(
    slug: string,
    id: string,
    opts: { activityAt?: string; entries?: object[] } = {},
  ): Promise<void> {
    await fs.promises.mkdir(sessionsDir(slug), { recursive: true })
    await fs.promises.writeFile(
      transcriptPath(slug, id),
      toJsonl(opts.entries ?? SAMPLE_JSONL_ENTRIES),
    )
    if (opts.activityAt) {
      const at = new Date(opts.activityAt)
      await fs.promises.utimes(transcriptPath(slug, id), at, at)
    }
  }

  async function writeMetadata(slug: string, metadata: Record<string, object>): Promise<void> {
    await fs.promises.mkdir(workspaceDir(slug), { recursive: true })
    await fs.promises.writeFile(
      path.join(workspaceDir(slug), 'session-metadata.json'),
      JSON.stringify(metadata),
    )
  }

  const ids = (sessions: { id: string }[]) => sessions.map((s) => s.id)

  it('skips an unregistered empty transcript but keeps a registered empty one', async () => {
    // Empty JSONLs are what the SDK leaves behind for subagent directories.
    // Only a registration turns one into a real (just-created) session.
    await writeTranscript('agent-a', 'sdk-artifact', { entries: [] })
    await writeTranscript('agent-a', 'registered-empty', { entries: [] })
    await writeTranscript('agent-a', 'real', { activityAt: '2026-01-01T00:00:00.000Z' })
    await writeMetadata('agent-a', {
      'registered-empty': { name: 'Just created', createdAt: '2026-01-02T00:00:00.000Z' },
    })

    const sessions = await list('agent-a', {
      excludeAutomated: true,
      sortBy: 'last_activity_at',
    })

    expect(ids(sessions)).toContain('registered-empty')
    expect(ids(sessions)).toContain('real')
    expect(ids(sessions)).not.toContain('sdk-artifact')
  })

  it('never lets a newer hidden automated transcript outrank an older visible one', async () => {
    await writeTranscript('agent-a', 'visible-old', { activityAt: '2026-01-01T00:00:00.000Z' })
    await writeTranscript('agent-a', 'scheduled-new', { activityAt: '2026-01-05T00:00:00.000Z' })
    await writeTranscript('agent-a', 'webhook-new', { activityAt: '2026-01-06T00:00:00.000Z' })
    await writeTranscript('agent-a', 'chat-new', { activityAt: '2026-01-07T00:00:00.000Z' })
    await writeTranscript('agent-a', 'x-agent-new', { activityAt: '2026-01-08T00:00:00.000Z' })
    await writeMetadata('agent-a', {
      'scheduled-new': { isScheduledExecution: true, scheduledTaskId: 't1' },
      'webhook-new': { isWebhookExecution: true, webhookTriggerId: 'w1' },
      'chat-new': { isChatIntegrationSession: true },
      'x-agent-new': { invokedByAgentSlug: 'caller' },
    })

    const latest = await list('agent-a', {
      excludeAutomated: true,
      sortBy: 'last_activity_at',
      limit: 1,
    })

    expect(ids(latest)).toEqual(['visible-old'])
  })

  it('lets a promoted automated transcript be latest', async () => {
    await writeTranscript('agent-a', 'visible-old', { activityAt: '2026-01-01T00:00:00.000Z' })
    await writeTranscript('agent-a', 'promoted-new', { activityAt: '2026-01-05T00:00:00.000Z' })
    await writeMetadata('agent-a', {
      'promoted-new': {
        isScheduledExecution: true,
        scheduledTaskId: 't1',
        promotedToInteractive: true,
      },
    })

    const latest = await list('agent-a', {
      excludeAutomated: true,
      sortBy: 'last_activity_at',
      limit: 1,
    })

    expect(ids(latest)).toEqual(['promoted-new'])
  })

  it('ranks a newer metadata-only session above an older transcript, with createdAt as its activity', async () => {
    await writeTranscript('agent-a', 'transcript-old', { activityAt: '2026-01-01T00:00:00.000Z' })
    await writeMetadata('agent-a', {
      'pending-new': { name: 'Pending', createdAt: '2026-01-03T00:00:00.000Z' },
    })

    const sessions = await list('agent-a', {
      excludeAutomated: true,
      sortBy: 'last_activity_at',
    })

    expect(ids(sessions)).toEqual(['pending-new', 'transcript-old'])
    expect(sessions[0]!.lastActivityAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
    expect(sessions[0]!.createdAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
  })

  it('reports lastActivityAt as the transcript mtime and orders by it', async () => {
    // Created in the opposite order to their activity so file-creation order
    // and lexical id order both disagree with the expected result.
    await writeTranscript('agent-a', 'a-oldest', { activityAt: '2026-01-01T00:00:00.000Z' })
    await writeTranscript('agent-a', 'c-newest', { activityAt: '2026-01-03T00:00:00.000Z' })
    await writeTranscript('agent-a', 'b-middle', { activityAt: '2026-01-02T00:00:00.000Z' })

    const sessions = await list('agent-a', { sortBy: 'last_activity_at' })

    expect(ids(sessions)).toEqual(['c-newest', 'b-middle', 'a-oldest'])
    expect(sessions.map((s) => s.lastActivityAt.toISOString())).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ])
  })

  it('resolves createdAt from metadata first, then birthtime, then mtime', async () => {
    await writeTranscript('agent-a', 'with-meta', { activityAt: '2026-01-02T00:00:00.000Z' })
    await writeTranscript('agent-a', 'no-meta', { activityAt: '2026-01-01T00:00:00.000Z' })
    await writeMetadata('agent-a', {
      'with-meta': { createdAt: '2025-12-25T00:00:00.000Z' },
    })

    const sessions = await list('agent-a')
    const withMeta = sessions.find((s) => s.id === 'with-meta')!
    const noMeta = sessions.find((s) => s.id === 'no-meta')!

    expect(withMeta.createdAt).toEqual(new Date('2025-12-25T00:00:00.000Z'))
    // Birthtime is filesystem-dependent (epoch 0 on network filesystems), so
    // derive the expectation from the same stat the service must fall back on.
    const stat = await fs.promises.stat(transcriptPath('agent-a', 'no-meta'))
    const expected = stat.birthtimeMs > 0 ? stat.birthtime : new Date(stat.mtimeMs)
    expect(noMeta.createdAt).toEqual(expected)
  })

  it('excludes transcripts and registrations owned by another agent', async () => {
    await writeTranscript('agent-a', 'own', { activityAt: '2026-01-01T00:00:00.000Z' })
    await fs.promises.mkdir(sessionsDir('agent-b'), { recursive: true })
    // Reserve first: the ownership index is built from disk on first use, so a
    // later foreign file in agent-a's directory is unowned by agent-a.
    // (The reservation also invalidates agent-b's summary, not agent-a's; the
    // summary-backed listing must still build agent-a's map after the foreign
    // file lands, which it does because the first read is cold.)
    await reserveSessionOwnership('agent-b', 'foreign-transcript')
    await reserveSessionOwnership('agent-b', 'foreign-pending')
    await writeTranscript('agent-a', 'foreign-transcript', { activityAt: '2026-01-09T00:00:00.000Z' })
    await writeMetadata('agent-a', {
      'foreign-pending': { name: 'Forged', createdAt: '2026-01-10T00:00:00.000Z' },
    })

    const sessions = await list('agent-a', {
      excludeAutomated: true,
      sortBy: 'last_activity_at',
    })

    expect(ids(sessions)).toEqual(['own'])
  })

  it('applies limit after ownership and visibility filtering on transcript-backed sessions', async () => {
    await writeTranscript('agent-a', 'visible-1', { activityAt: '2026-01-01T00:00:00.000Z' })
    await writeTranscript('agent-a', 'visible-2', { activityAt: '2026-01-02T00:00:00.000Z' })
    await writeTranscript('agent-a', 'hidden-3', { activityAt: '2026-01-03T00:00:00.000Z' })
    await writeTranscript('agent-a', 'empty-4', { entries: [] })
    await fs.promises.mkdir(sessionsDir('agent-b'), { recursive: true })
    await reserveSessionOwnership('agent-b', 'foreign-5')
    await writeTranscript('agent-a', 'foreign-5', { activityAt: '2026-01-05T00:00:00.000Z' })
    await writeMetadata('agent-a', {
      'hidden-3': { isScheduledExecution: true, scheduledTaskId: 't' },
    })

    const sessions = await list('agent-a', {
      excludeAutomated: true,
      sortBy: 'last_activity_at',
      limit: 2,
    })

    expect(ids(sessions)).toEqual(['visible-2', 'visible-1'])
  })

  it('produces the canonical visible ordering for a mixed directory', async () => {
    // One fixture with every kind of entry the listing has to classify. The
    // expected order is the contract the route's "latest visible session" and
    // attention computation are built on.
    await writeTranscript('agent-a', 'visible-jan1', { activityAt: '2026-01-01T00:00:00.000Z' })
    await writeTranscript('agent-a', 'visible-jan4', { activityAt: '2026-01-04T00:00:00.000Z' })
    await writeTranscript('agent-a', 'promoted-jan3', { activityAt: '2026-01-03T00:00:00.000Z' })
    await writeTranscript('agent-a', 'hidden-jan6', { activityAt: '2026-01-06T00:00:00.000Z' })
    await writeTranscript('agent-a', 'sdk-artifact', { entries: [] })
    await writeTranscript('agent-a', 'registered-empty-jan2', { entries: [] })
    // Metadata (including metadata-only sessions) must exist before the first
    // ownership lookup below, which indexes agent-a's sessions from disk.
    await writeMetadata('agent-a', {
      'promoted-jan3': {
        isWebhookExecution: true,
        webhookTriggerId: 'w',
        promotedToInteractive: true,
      },
      'hidden-jan6': { isChatIntegrationSession: true },
      'registered-empty-jan2': { createdAt: '2026-01-02T00:00:00.000Z' },
      'pending-jan5': { createdAt: '2026-01-05T00:00:00.000Z' },
      'pending-hidden-jan8': { createdAt: '2026-01-08T00:00:00.000Z', invokedByAgentSlug: 'x' },
    })
    await fs.promises.mkdir(sessionsDir('agent-b'), { recursive: true })
    await reserveSessionOwnership('agent-b', 'foreign-jan7')
    await writeTranscript('agent-a', 'foreign-jan7', { activityAt: '2026-01-07T00:00:00.000Z' })
    // registered-empty-jan2 is an existing (empty) file; pin its activity too.
    const jan2 = new Date('2026-01-02T00:00:00.000Z')
    await fs.promises.utimes(transcriptPath('agent-a', 'registered-empty-jan2'), jan2, jan2)

    const visible = await list('agent-a', {
      excludeAutomated: true,
      sortBy: 'last_activity_at',
    })

    expect(ids(visible)).toEqual([
      'pending-jan5',
      'visible-jan4',
      'promoted-jan3',
      'registered-empty-jan2',
      'visible-jan1',
    ])

    const everything = await list('agent-a', { sortBy: 'last_activity_at' })
    expect(ids(everything)).toEqual([
      'pending-hidden-jan8',
      'hidden-jan6',
      'pending-jan5',
      'visible-jan4',
      'promoted-jan3',
      'registered-empty-jan2',
      'visible-jan1',
    ])
  })
})

describe('getSessionMessagesPage without a transcript', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-page-missing-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('returns an empty terminal page instead of throwing', async () => {
    // A registered session that has not streamed yet has no JSONL. Callers
    // rely on this being an empty page, not an error, so they can skip their
    // own existence checks.
    await fs.promises.mkdir(
      path.join(testDir, 'agents', 'agent-a', 'workspace', '.claude', 'projects', '-workspace'),
      { recursive: true },
    )

    await expect(
      getSessionMessagesPage('agent-a', 'not-written-yet', { limit: 20, media: 'ref' }),
    ).resolves.toEqual({ messages: [], nextCursor: null })
  })

  it('returns an empty terminal page when the sessions directory itself is absent', async () => {
    await expect(
      getSessionMessagesPage('agent-a', 'not-written-yet', { limit: 20 }),
    ).resolves.toEqual({ messages: [], nextCursor: null })
  })
})
