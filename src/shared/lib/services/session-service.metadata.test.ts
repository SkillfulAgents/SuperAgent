/**
 * session-metadata.json must never silently lose session names.
 *
 * Regression coverage for the data-loss bug-class: a non-atomic
 * read-modify-write with no serialization, plus a read that swallowed parse
 * errors into `{}` which was then written back. Under concurrent/interrupted
 * writes this permanently wiped every session name. These tests assert the three
 * properties that close it: serialized writes (no lost updates), atomic writes,
 * and fail-closed reads (a corrupt file aborts the write instead of clobbering).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'

let tmpDir: string

function workspaceDir(slug: string): string {
  return path.join(tmpDir, 'agents', slug, 'workspace')
}
function metadataPath(slug: string): string {
  return path.join(workspaceDir(slug), 'session-metadata.json')
}
function makeAgent(slug: string): void {
  fs.mkdirSync(workspaceDir(slug), { recursive: true })
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-meta-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SUPERAGENT_DATA_DIR
  vi.restoreAllMocks()
})

async function importService() {
  return import('./session-service')
}

describe('lost-update protection (serialized read-modify-write)', () => {
  it('preserves ALL names when many registrations race concurrently', async () => {
    const { registerSession, readSessionMetadata } = await importService()
    makeAgent('busy-agent')

    const ids = Array.from({ length: 40 }, (_, i) => `session-${i}`)
    // Fire every registration at once — the original code lost most of these.
    await Promise.all(ids.map((id) => registerSession(createLocalSessionStore('busy-agent'), id, `Name ${id}`)))

    const meta = await readSessionMetadata(createLocalSessionStore('busy-agent'))
    expect(Object.keys(meta).sort()).toEqual([...ids].sort())
    for (const id of ids) {
      expect(meta[id].name).toBe(`Name ${id}`)
    }
  })

  it('preserves prior names when a registration races a rename', async () => {
    const { registerSession, updateSessionName, readSessionMetadata } = await importService()
    makeAgent('agent')

    // Seed 10 existing named sessions.
    for (let i = 0; i < 10; i++) {
      await registerSession(createLocalSessionStore('agent'), `existing-${i}`, `Existing ${i}`)
    }

    // Concurrently: register a new session AND rename several existing ones.
    await Promise.all([
      registerSession(createLocalSessionStore('agent'), 'new-session', 'Brand New'),
      updateSessionName(createLocalSessionStore('agent'), 'existing-0', 'Renamed 0'),
      updateSessionName(createLocalSessionStore('agent'), 'existing-5', 'Renamed 5'),
      updateSessionName(createLocalSessionStore('agent'), 'existing-9', 'Renamed 9'),
    ])

    const meta = await readSessionMetadata(createLocalSessionStore('agent'))
    expect(Object.keys(meta)).toHaveLength(11)
    expect(meta['new-session'].name).toBe('Brand New')
    expect(meta['existing-0'].name).toBe('Renamed 0')
    expect(meta['existing-5'].name).toBe('Renamed 5')
    expect(meta['existing-9'].name).toBe('Renamed 9')
    expect(meta['existing-1'].name).toBe('Existing 1') // untouched survives
  })

  it('concurrent partial updates to the same session merge without dropping fields', async () => {
    const { registerSession, updateSessionMetadata, getSessionMetadata } = await importService()
    makeAgent('agent')
    await registerSession(createLocalSessionStore('agent'), 's1', 'Original')

    await Promise.all([
      updateSessionMetadata(createLocalSessionStore('agent'), 's1', { starred: true }),
      updateSessionMetadata(createLocalSessionStore('agent'), 's1', { effort: 'high' }),
      updateSessionMetadata(createLocalSessionStore('agent'), 's1', { model: 'opus' }),
    ])

    const meta = await getSessionMetadata(createLocalSessionStore('agent'), 's1')
    expect(meta).toMatchObject({ name: 'Original', starred: true, effort: 'high', model: 'opus' })
  })

  it('updateSessionMetadata returns the pre-update entry so callers can detect real changes', async () => {
    const { registerSession, updateSessionMetadata } = await importService()
    makeAgent('agent')

    // No entry yet → undefined (the caller treats every value as a change).
    const beforeRegister = await updateSessionMetadata(createLocalSessionStore('agent'), 'fresh', { model: 'opus' })
    expect(beforeRegister).toBeUndefined()

    await registerSession(createLocalSessionStore('agent'), 's1', 'Original')
    await updateSessionMetadata(createLocalSessionStore('agent'), 's1', { model: 'opus', effort: 'high' })
    const previous = await updateSessionMetadata(createLocalSessionStore('agent'), 's1', { model: 'haiku' })
    expect(previous).toMatchObject({ name: 'Original', model: 'opus', effort: 'high' })
  })
})

describe('no-op updates', () => {
  // A write replaces the file through a rename, so a new inode is the mark of one.
  const fileIdentity = (slug: string) => {
    const stat = fs.statSync(metadataPath(slug))
    return { ino: stat.ino, mtimeMs: stat.mtimeMs }
  }

  it('writes nothing when every value is already stored', async () => {
    const { registerSession, updateSessionMetadata } = await importService()
    makeAgent('agent')
    await registerSession(createLocalSessionStore('agent'), 's1', 'Original')
    await updateSessionMetadata(createLocalSessionStore('agent'), 's1', {
      model: 'opus',
      effort: 'high',
      alertDeviceId: null,
      lastWake: { taskId: 't1', executionAt: '2026-01-01T00:00:00.000Z' },
    })
    const before = fileIdentity('agent')

    const store = createLocalSessionStore('agent')
    const previous = await updateSessionMetadata(store, 's1', { model: 'opus', effort: 'high' })
    await updateSessionMetadata(store, 's1', { alertDeviceId: null })
    // Equal by value, not by reference.
    await updateSessionMetadata(store, 's1', { lastWake: { taskId: 't1', executionAt: '2026-01-01T00:00:00.000Z' } })
    // An undefined value is the absent key it would serialize to.
    await updateSessionMetadata(store, 's1', { starred: undefined })
    await updateSessionMetadata(store, 's1', {})

    expect(fileIdentity('agent')).toEqual(before)
    expect(previous).toMatchObject({ name: 'Original', model: 'opus', effort: 'high' })
    expect(fs.readdirSync(workspaceDir('agent')).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('writes when any one value differs, null against absent included', async () => {
    const { registerSession, updateSessionMetadata, getSessionMetadata } = await importService()
    makeAgent('agent')
    await registerSession(createLocalSessionStore('agent'), 's1', 'Original')
    await updateSessionMetadata(createLocalSessionStore('agent'), 's1', { model: 'opus' })
    const before = fileIdentity('agent')

    // Explicit null clears the alert claim; absent falls back to the creation stamp.
    await updateSessionMetadata(createLocalSessionStore('agent'), 's1', { model: 'opus', alertDeviceId: null })

    expect(fileIdentity('agent').ino).not.toBe(before.ino)
    const meta = await getSessionMetadata(createLocalSessionStore('agent'), 's1')
    expect(meta).toMatchObject({ name: 'Original', model: 'opus', alertDeviceId: null })
  })

  it('creates the entry of a session that has none, however little the update says', async () => {
    const { registerSession, updateSessionMetadata, isSessionRegistered } = await importService()
    makeAgent('agent')
    await registerSession(createLocalSessionStore('agent'), 'other', 'Other')

    expect(await updateSessionMetadata(createLocalSessionStore('agent'), 'fresh', {})).toBeUndefined()
    expect(await isSessionRegistered(createLocalSessionStore('agent'), 'fresh')).toBe(true)
  })
})

describe('atomic writes', () => {
  it('writes valid JSON and leaves no temp file behind', async () => {
    const { registerSession } = await importService()
    makeAgent('agent')
    await registerSession(createLocalSessionStore('agent'), 's1', 'Session One')

    const dir = workspaceDir('agent')
    const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(stray).toEqual([])
    // File parses cleanly.
    expect(() => JSON.parse(fs.readFileSync(metadataPath('agent'), 'utf-8'))).not.toThrow()
  })
})

describe('fail-closed on corrupt metadata (no clobbering)', () => {
  it('registerSession THROWS and does NOT overwrite a corrupt file with a near-empty map', async () => {
    const { registerSession } = await importService()
    makeAgent('agent')
    // A torn/half-written file — the exact corruption that triggered the incident.
    const corrupt = '{ "old-session": { "name": "Precious '
    fs.writeFileSync(metadataPath('agent'), corrupt)

    await expect(registerSession(createLocalSessionStore('agent'), 'new-session', 'New')).rejects.toThrow()

    // The corrupt bytes are still on disk — NOT replaced by `{ "new-session": ... }`.
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(corrupt)
  })

  it('updateSessionName THROWS on corrupt file and preserves it for recovery', async () => {
    const { updateSessionName } = await importService()
    makeAgent('agent')
    const corrupt = 'not json at all'
    fs.writeFileSync(metadataPath('agent'), corrupt)

    await expect(updateSessionName(createLocalSessionStore('agent'), 's1', 'X')).rejects.toThrow()
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(corrupt)
  })

  it('read-only readSessionMetadata degrades to {} on corrupt WITHOUT writing', async () => {
    const { readSessionMetadata } = await importService()
    makeAgent('agent')
    const corrupt = '{ broken'
    fs.writeFileSync(metadataPath('agent'), corrupt)

    // Listing/display must not crash — it returns {} so sessions fall back to
    // auto-titles — but it must not rewrite the file.
    const meta = await readSessionMetadata(createLocalSessionStore('agent'))
    expect(meta).toEqual({})
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(corrupt)
  })

  it('absent file is treated as empty (not corrupt) and does not throw', async () => {
    const { readSessionMetadata, registerSession, getSessionMetadata } = await importService()
    makeAgent('agent')
    expect(await readSessionMetadata(createLocalSessionStore('agent'))).toEqual({})
    await registerSession(createLocalSessionStore('agent'), 's1', 'First')
    expect((await getSessionMetadata(createLocalSessionStore('agent'), 's1'))?.name).toBe('First')
  })
})

describe('deletes preserve siblings', () => {
  it('deleteSessionsBatch only removes metadata for sessions whose JSONL it removed', async () => {
    const { registerSession, deleteSessionsBatch, readSessionMetadata } = await importService()
    makeAgent('agent')
    for (let i = 0; i < 5; i++) await registerSession(createLocalSessionStore('agent'), `s${i}`, `S${i}`)

    // None have JSONL files on disk; deleteSessionsBatch treats missing JSONL as
    // ENOENT-deleted and drops their metadata, leaving the rest intact.
    const deleted = await deleteSessionsBatch(createLocalSessionStore('agent'), ['s1', 's3'])
    expect(deleted.sort()).toEqual(['s1', 's3'])

    const meta = await readSessionMetadata(createLocalSessionStore('agent'))
    expect(Object.keys(meta).sort()).toEqual(['s0', 's2', 's4'])
  })

  it('deleteSessionsBatch throws on corrupt metadata rather than rewriting it', async () => {
    const { deleteSessionsBatch } = await importService()
    makeAgent('agent')
    const corrupt = '{ "s0": { '
    fs.writeFileSync(metadataPath('agent'), corrupt)

    await expect(deleteSessionsBatch(createLocalSessionStore('agent'), ['s0'])).rejects.toThrow()
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(corrupt)
  })
})

describe('finalizeAutomationStatus guards', () => {
  it('finalizes a running automation session and reports updated', async () => {
    const { registerSession, finalizeAutomationStatus, getSessionMetadata } = await importService()
    makeAgent('agent')
    await registerSession(createLocalSessionStore('agent'), 'cron-run', 'Nightly report', {
      isScheduledExecution: true,
      scheduledTaskId: 'task-1',
      automationStatus: 'running',
    })

    expect(await finalizeAutomationStatus(createLocalSessionStore('agent'), 'cron-run', 'succeeded')).toBe('updated')
    expect((await getSessionMetadata(createLocalSessionStore('agent'), 'cron-run'))?.automationStatus).toBe('succeeded')
  })

  it('finalizes a widget-repair session, so the in-flight guard can clear', async () => {
    const { registerSession, finalizeAutomationStatus, getSessionMetadata } = await importService()
    makeAgent('agent')
    await registerSession(createLocalSessionStore('agent'), 'repair', 'Fix widget: macros', {
      isWidgetRepair: true,
      widgetRepairSlug: 'macros',
      automationStatus: 'running',
    })

    expect(await finalizeAutomationStatus(createLocalSessionStore('agent'), 'repair', 'succeeded')).toBe('updated')
    expect((await getSessionMetadata(createLocalSessionStore('agent'), 'repair'))?.automationStatus).toBe('succeeded')
  })

  it('reports not-automation for a regular session and leaves it untouched', async () => {
    const { registerSession, finalizeAutomationStatus, getSessionMetadata } = await importService()
    makeAgent('agent')
    await registerSession(createLocalSessionStore('agent'), 'chat', 'Regular session')

    expect(await finalizeAutomationStatus(createLocalSessionStore('agent'), 'chat', 'succeeded')).toBe('not-automation')
    expect((await getSessionMetadata(createLocalSessionStore('agent'), 'chat'))?.automationStatus).toBeUndefined()
  })

  it('never overwrites a finalized outcome with a later turn result', async () => {
    const { registerSession, finalizeAutomationStatus, getSessionMetadata } = await importService()
    makeAgent('agent')
    await registerSession(createLocalSessionStore('agent'), 'webhook-run', 'Email handler', {
      isWebhookExecution: true,
      webhookTriggerId: 'trigger-1',
      automationStatus: 'running',
    })

    expect(await finalizeAutomationStatus(createLocalSessionStore('agent'), 'webhook-run', 'failed')).toBe('updated')
    expect(await finalizeAutomationStatus(createLocalSessionStore('agent'), 'webhook-run', 'succeeded')).toBe('already-final')
    expect((await getSessionMetadata(createLocalSessionStore('agent'), 'webhook-run'))?.automationStatus).toBe('failed')
  })

  it('does not attribute an interactive result to a promoted legacy automation session', async () => {
    const { registerSession, finalizeAutomationStatus, updateSessionMetadata, getSessionMetadata } = await importService()
    makeAgent('agent')
    // Pre-outcome-tracking session: automation flags but no automationStatus.
    await registerSession(createLocalSessionStore('agent'), 'legacy', 'Old webhook run', {
      isWebhookExecution: true,
      webhookTriggerId: 'trigger-1',
    })
    await updateSessionMetadata(createLocalSessionStore('agent'), 'legacy', { promotedToInteractive: true })

    expect(await finalizeAutomationStatus(createLocalSessionStore('agent'), 'legacy', 'failed')).toBe('not-automation')
    expect((await getSessionMetadata(createLocalSessionStore('agent'), 'legacy'))?.automationStatus).toBeUndefined()
  })

  it('aborts on corrupt metadata instead of clobbering it', async () => {
    const { finalizeAutomationStatus } = await importService()
    makeAgent('agent')
    const corrupt = '{ "s0": { '
    fs.writeFileSync(metadataPath('agent'), corrupt)

    await expect(finalizeAutomationStatus(createLocalSessionStore('agent'), 's0', 'succeeded')).rejects.toThrow()
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(corrupt)
  })
})

describe('slash commands stored in session entries by earlier builds', () => {
  const older = [{ name: 'deploy', description: 'Ship it', argumentHint: '' }]
  const newer = [{ name: 'deploy', description: 'Ship it', argumentHint: '' }, { name: 'review', description: 'Review it', argumentHint: '' }]
  const agentCopyPath = () => path.join(workspaceDir('agent'), '.slash-commands.json')

  it('drops every copy on the next write and keeps the newest as the agent copy', async () => {
    const { registerSession, readSessionMetadata, readAgentSlashCommands } = await importService()
    makeAgent('agent')
    fs.writeFileSync(metadataPath('agent'), JSON.stringify({
      'webhook-run': { name: 'Webhook run', createdAt: '2026-10-01T00:00:00Z', isWebhookExecution: true, slashCommands: older },
      'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00Z', slashCommands: newer },
      'promoted-run': { name: 'Promoted run', createdAt: '2026-10-10T00:00:00Z', isWebhookExecution: true, promotedToInteractive: true, slashCommands: older },
    }, null, 2))

    await registerSession(createLocalSessionStore('agent'), 'new-chat', 'New chat')

    const meta = await readSessionMetadata(createLocalSessionStore('agent'))
    expect(Object.values(meta).some((entry) => entry.slashCommands)).toBe(false)
    expect(meta['user-chat']).toEqual({ name: 'User chat', createdAt: '2026-10-20T00:00:00Z' })
    expect(meta['new-chat'].name).toBe('New chat')
    expect(await readAgentSlashCommands(createLocalSessionStore('agent'))).toEqual(newer)
  })

  it('keeps an agent copy that already exists', async () => {
    const { updateSessionMetadata, storeAgentSlashCommands, readAgentSlashCommands } = await importService()
    makeAgent('agent')
    await storeAgentSlashCommands(createLocalSessionStore('agent'), newer)
    fs.writeFileSync(metadataPath('agent'), JSON.stringify({
      'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00Z', slashCommands: older },
    }, null, 2))

    await updateSessionMetadata(createLocalSessionStore('agent'), 'user-chat', { starred: true })

    expect(await readAgentSlashCommands(createLocalSessionStore('agent'))).toEqual(newer)
  })

  it('writes a no-op update when it has copies to drop, and skips it once there are none', async () => {
    const { updateSessionMetadata } = await importService()
    makeAgent('agent')
    fs.writeFileSync(metadataPath('agent'), JSON.stringify({
      'webhook-run': { name: 'Webhook run', isWebhookExecution: true, slashCommands: older },
    }, null, 2))

    await updateSessionMetadata(createLocalSessionStore('agent'), 'webhook-run', { name: 'Webhook run' })
    const cleaned = fs.readFileSync(metadataPath('agent'), 'utf-8')
    expect(JSON.parse(cleaned)['webhook-run'].slashCommands).toBeUndefined()

    const mtime = fs.statSync(metadataPath('agent')).mtimeMs
    await updateSessionMetadata(createLocalSessionStore('agent'), 'webhook-run', { name: 'Webhook run' })
    expect(fs.statSync(metadataPath('agent')).mtimeMs).toBe(mtime)
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(cleaned)
  })

  it('rewrites the agent copy only when the list changes', async () => {
    const { storeAgentSlashCommands } = await importService()
    makeAgent('agent')
    await storeAgentSlashCommands(createLocalSessionStore('agent'), older)
    const mtime = fs.statSync(agentCopyPath()).mtimeMs

    await storeAgentSlashCommands(createLocalSessionStore('agent'), older)
    expect(fs.statSync(agentCopyPath()).mtimeMs).toBe(mtime)

    await storeAgentSlashCommands(createLocalSessionStore('agent'), newer)
    expect(JSON.parse(fs.readFileSync(agentCopyPath(), 'utf-8'))).toEqual(newer)
  })

  it('reads the newest session copy when the agent has none, whichever session is opened', async () => {
    const { readAgentSlashCommands } = await importService()
    makeAgent('agent')
    fs.writeFileSync(metadataPath('agent'), JSON.stringify({
      'old-chat': { name: 'Old chat', createdAt: '2026-10-01T00:00:00Z', slashCommands: older },
      'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00Z', slashCommands: newer },
    }, null, 2))

    expect(await readAgentSlashCommands(createLocalSessionStore('agent'))).toEqual(newer)
  })

  it('reads the session copies when the agent copy is corrupt, and leaves the file alone', async () => {
    const { readAgentSlashCommands } = await importService()
    makeAgent('agent')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fs.writeFileSync(metadataPath('agent'), JSON.stringify({
      'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00Z', slashCommands: older },
    }, null, 2))
    fs.writeFileSync(agentCopyPath(), '[{')

    expect(await readAgentSlashCommands(createLocalSessionStore('agent'))).toEqual(older)
    expect(fs.readFileSync(agentCopyPath(), 'utf-8')).toBe('[{')
  })
})
