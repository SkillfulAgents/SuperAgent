import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import * as os from 'os'

const statProbe = vi.hoisted(() => ({
  paths: [] as string[],
  beforeStat: undefined as ((file: string) => Promise<void>) | undefined,
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: (async (...args: Parameters<typeof actual.promises.stat>) => {
        const file = String(args[0])
        statProbe.paths.push(file)
        await statProbe.beforeStat?.(file)
        return actual.promises.stat(...args)
      }) as typeof actual.promises.stat,
    },
  }
})

import * as fs from 'fs'
import {
  deleteSession,
  getSessionSummary,
  registerSession,
  reserveSessionOwnership,
} from './session-service'
import { recordSessionActivity } from './session-summary-cache'
import { appendInformationalEntry } from './session-transcript-append'

describe('getSessionSummary cache', () => {
  let testRoot: string
  let priorDataDir: string | undefined
  const agentSlug = 'summary-agent'

  const workspaceDir = () => path.join(testRoot, 'agents', agentSlug, 'workspace')
  const sessionsDir = () => path.join(workspaceDir(), '.claude', 'projects', '-workspace')
  const transcriptPath = (sessionId: string) => path.join(sessionsDir(), `${sessionId}.jsonl`)

  beforeEach(async () => {
    testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-summary-cache-'))
    priorDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testRoot
    await fs.promises.mkdir(workspaceDir(), { recursive: true })
    statProbe.paths.length = 0
    statProbe.beforeStat = undefined
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    statProbe.beforeStat = undefined
    if (priorDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = priorDataDir
    await fs.promises.rm(testRoot, { recursive: true, force: true })
  })

  async function createSession(sessionId: string, activityAt: string): Promise<void> {
    await registerSession(agentSlug, sessionId, sessionId)
    await fs.promises.mkdir(sessionsDir(), { recursive: true })
    await fs.promises.writeFile(transcriptPath(sessionId), '{}\n')
    const timestamp = new Date(activityAt)
    await fs.promises.utimes(transcriptPath(sessionId), timestamp, timestamp)
  }

  it('serves a warm summary with one directory stat and no transcript stats', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')

    expect((await getSessionSummary(agentSlug)).sessionCount).toBe(2)
    statProbe.paths.length = 0

    const warm = await getSessionSummary(agentSlug)

    expect(warm.sessionIds.sort()).toEqual(['session-a', 'session-b'])
    expect(warm.lastActivityAt).toEqual(new Date('2026-01-02T00:00:00.000Z'))
    expect(statProbe.paths).toEqual([sessionsDir()])
  })

  it('reconciles the full map when a transcript is structurally added', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    await createSession('session-b', '2026-01-03T00:00:00.000Z')
    const changedAt = new Date('2026-02-01T00:00:00.000Z')
    await fs.promises.utimes(sessionsDir(), changedAt, changedAt)
    statProbe.paths.length = 0

    const changed = await getSessionSummary(agentSlug)

    expect(changed.sessionIds.sort()).toEqual(['session-a', 'session-b'])
    expect(changed.lastActivityAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
    expect(statProbe.paths.filter((file) => file.endsWith('.jsonl'))).toHaveLength(2)
  })

  it('reconciles unchanged directory contents when ownership is newly reserved', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await fs.promises.mkdir(sessionsDir(), { recursive: true })
    await fs.promises.writeFile(transcriptPath('session-b'), '{}\n')
    expect((await getSessionSummary(agentSlug)).sessionIds).toEqual(['session-a'])

    await reserveSessionOwnership(agentSlug, 'session-b')
    const summary = await getSessionSummary(agentSlug)

    expect(summary.sessionIds.sort()).toEqual(['session-a', 'session-b'])
  })

  it('applies observed activity without restatting unchanged sibling transcripts', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(agentSlug)
    statProbe.paths.length = 0

    recordSessionActivity(agentSlug, 'session-a', new Date('2026-01-04T12:00:00.000Z'))
    const updated = await getSessionSummary(agentSlug)

    expect(updated.lastActivityAt).toEqual(new Date('2026-01-04T12:00:00.000Z'))
    expect(statProbe.paths).toEqual([sessionsDir()])
  })

  it('does not fabricate a session from an activity signal alone', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    recordSessionActivity(agentSlug, 'not-on-disk', new Date('2030-01-01T00:00:00.000Z'))
    const summary = await getSessionSummary(agentSlug)

    expect(summary.sessionIds).toEqual(['session-a'])
    expect(summary.lastActivityAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('merges activity observed while the initial filesystem scan is in flight', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    let releaseStat!: () => void
    let enteredStat!: () => void
    const held = new Promise<void>((resolve) => { releaseStat = resolve })
    const entered = new Promise<void>((resolve) => { enteredStat = resolve })
    statProbe.beforeStat = async (file) => {
      if (file === transcriptPath('session-a')) {
        enteredStat()
        await held
      }
    }

    const loading = getSessionSummary(agentSlug)
    await entered
    recordSessionActivity(agentSlug, 'session-a', new Date('2026-01-05T00:00:00.000Z'))
    releaseStat()

    expect((await loading).lastActivityAt).toEqual(new Date('2026-01-05T00:00:00.000Z'))
  })

  it('observes a host-authored informational append without fabricating replay activity', async () => {
    const firstActivity = new Date('2030-01-01T00:00:00.000Z').getTime()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(firstActivity)
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    const entry = { uuid: 'informational-1', content: 'Prompt blocked', level: 'warning' }
    await appendInformationalEntry(agentSlug, 'session-a', entry)
    expect((await getSessionSummary(agentSlug)).lastActivityAt).toEqual(new Date(firstActivity))

    clock.mockReturnValue(firstActivity + 1_000)
    await appendInformationalEntry(agentSlug, 'session-a', entry)
    expect((await getSessionSummary(agentSlug)).lastActivityAt).toEqual(new Date(firstActivity))
  })

  it('drops a deleted session from an already-warm summary', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    await deleteSession(agentSlug, 'session-b')
    const summary = await getSessionSummary(agentSlug)

    expect(summary.sessionIds).toEqual(['session-a'])
    expect(summary.lastActivityAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('omits a transcript deleted between readdir and stat instead of failing the scan', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    statProbe.beforeStat = async (file) => {
      if (file === transcriptPath('session-b')) {
        await fs.promises.rm(transcriptPath('session-b'), { force: true })
      }
    }

    const summary = await getSessionSummary(agentSlug)

    expect(summary.sessionIds).toEqual(['session-a'])
    expect(summary.lastActivityAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('periodically rebuilds unchanged directories to recover missed external writes', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    clock.mockReturnValue(1_800_000_000_000 + 10 * 60 * 1000)
    statProbe.paths.length = 0
    await getSessionSummary(agentSlug)

    expect(statProbe.paths).toContain(transcriptPath('session-a'))
  })
})
