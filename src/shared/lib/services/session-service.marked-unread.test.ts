/**
 * "Mark as unread" (SUP-686) persists a user-driven flag on session metadata
 * rather than un-reading notification rows, so the dot works for sessions that
 * never produced a notification and never resurfaces anything in the inbox.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

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
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-unread-')))
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

/** The routes derive this from a map they already hold; mirror that here. */
async function markedUnreadIds(slug: string): Promise<Set<string>> {
  const { readSessionMetadata, collectSessionIdsMarkedUnread } = await importService()
  return collectSessionIdsMarkedUnread(await readSessionMetadata(slug))
}

describe('setSessionMarkedUnread', () => {
  it('raises the flag and lists the session as marked unread', async () => {
    const { registerSession, setSessionMarkedUnread } = await importService()
    makeAgent('agent')
    await registerSession('agent', 'session-1', 'One')

    expect(await markedUnreadIds('agent')).toEqual(new Set())

    await setSessionMarkedUnread('agent', 'session-1', true)

    expect(await markedUnreadIds('agent')).toEqual(new Set(['session-1']))
  })

  it('clears the flag by removing the key, not by storing false', async () => {
    const { registerSession, setSessionMarkedUnread, readSessionMetadata } = await importService()
    makeAgent('agent')
    await registerSession('agent', 'session-1', 'One')

    await setSessionMarkedUnread('agent', 'session-1', true)
    await setSessionMarkedUnread('agent', 'session-1', false)

    const meta = await readSessionMetadata('agent')
    expect(Object.hasOwn(meta['session-1'], 'markedUnread')).toBe(false)
    // Clearing must not cost the session its other metadata.
    expect(meta['session-1'].name).toBe('One')
  })

  it('does not rewrite the file when clearing a flag that was never set', async () => {
    const { registerSession, setSessionMarkedUnread } = await importService()
    makeAgent('agent')
    await registerSession('agent', 'session-1', 'One')

    // Every session open fires a clear; a session that was never marked must
    // not turn that into a write + file-lock round trip.
    const before = fs.statSync(metadataPath('agent')).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 10))
    await setSessionMarkedUnread('agent', 'session-1', false)

    expect(fs.statSync(metadataPath('agent')).mtimeMs).toBe(before)
  })

  // The clear fires on every session open and the client skips its cache
  // invalidation when nothing was written — refetching the session list and
  // re-enriching every agent for a no-op is what this return value avoids.
  it('reports whether it actually wrote, so a no-op clear can skip invalidation', async () => {
    const { registerSession, setSessionMarkedUnread } = await importService()
    makeAgent('agent')
    await registerSession('agent', 'session-1', 'One')

    expect(await setSessionMarkedUnread('agent', 'session-1', false)).toBe(false)
    expect(await setSessionMarkedUnread('agent', 'session-1', true)).toBe(true)
    expect(await setSessionMarkedUnread('agent', 'session-1', true)).toBe(false)
    expect(await setSessionMarkedUnread('agent', 'session-1', false)).toBe(true)
  })

  // A session with a transcript on disk but no metadata registration gets its
  // entry conjured by the raise. Clearing must take the entry with it: `{}` is
  // truthy, so leaving one behind would defeat the `stat.size === 0 &&
  // !metadata[sessionId]` guard that hides empty SDK-subagent JSONLs.
  it('drops the whole entry when the flag was its only field', async () => {
    const { setSessionMarkedUnread, readSessionMetadata } = await importService()
    makeAgent('agent')

    await setSessionMarkedUnread('agent', 'unregistered', true)
    expect(await readSessionMetadata('agent')).toEqual({ unregistered: { markedUnread: true } })

    await setSessionMarkedUnread('agent', 'unregistered', false)

    expect(await readSessionMetadata('agent')).toEqual({})
  })

  it('survives a metadata read-write round trip through the Zod boundary', async () => {
    const { registerSession, setSessionMarkedUnread, updateSessionName, readSessionMetadata } =
      await importService()
    makeAgent('agent')
    await registerSession('agent', 'session-1', 'One')
    await setSessionMarkedUnread('agent', 'session-1', true)

    // An unrelated write re-reads and re-validates the whole map; a field
    // missing from the schema would be dropped here.
    await updateSessionName('agent', 'session-1', 'Renamed')

    const meta = await readSessionMetadata('agent')
    expect(meta['session-1'].markedUnread).toBe(true)
    expect(meta['session-1'].name).toBe('Renamed')
  })
})

describe('collectSessionIdsMarkedUnread', () => {
  it('skips hidden automated sessions, which no session list would ever show', async () => {
    const { registerSession, updateSessionMetadata, setSessionMarkedUnread } =
      await importService()
    makeAgent('agent')
    await registerSession('agent', 'cron-session', 'Cron')
    await updateSessionMetadata('agent', 'cron-session', { isScheduledExecution: true })
    await setSessionMarkedUnread('agent', 'cron-session', true)

    expect(await markedUnreadIds('agent')).toEqual(new Set())
  })

  it('includes an automated session once it has been promoted to interactive', async () => {
    const { registerSession, updateSessionMetadata, setSessionMarkedUnread } =
      await importService()
    makeAgent('agent')
    await registerSession('agent', 'cron-session', 'Cron')
    await updateSessionMetadata('agent', 'cron-session', {
      isScheduledExecution: true,
      promotedToInteractive: true,
    })
    await setSessionMarkedUnread('agent', 'cron-session', true)

    expect(await markedUnreadIds('agent')).toEqual(new Set(['cron-session']))
  })
})
