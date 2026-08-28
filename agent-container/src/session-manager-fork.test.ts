import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const sdkFork = vi.fn()
const sdkDelete = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: (...args: unknown[]) => sdkFork(...args),
  deleteSession: (...args: unknown[]) => sdkDelete(...args),
  query: vi.fn(),
  startup: vi.fn(),
}))

const persisted = new Map<string, Record<string, unknown>>()
const saveChecked = vi.fn((meta: { sessionId: string } & Record<string, unknown>) => {
  persisted.set(meta.sessionId, meta)
})
vi.mock('./session-persistence', () => ({
  SessionPersistence: class {
    saveSession(meta: { sessionId: string } & Record<string, unknown>) { persisted.set(meta.sessionId, meta) }
    saveSessionChecked(meta: { sessionId: string } & Record<string, unknown>) { saveChecked(meta) }
    getSession(id: string) { return persisted.get(id) ?? null }
    deleteSession(id: string) { persisted.delete(id) }
    updateLastActivity() {}
    updateEffort() {}
    updateModel() {}
    updateMetadata() {}
    addSessionCapabilityGrant() {}
    getAllSessions() { return [...persisted.values()] }
  },
}))
vi.mock('./browser-state', () => ({ releaseBrowserLock: () => false }))
vi.mock('./claude-code', () => ({ ClaudeCodeProcess: class {} }))

import { SessionManager, SessionBusyError } from './session-manager'

const source = {
  sessionId: 'src-1',
  claudeSessionId: 'src-1',
  workingDirectory: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActivity: '2026-01-01T00:00:00.000Z',
  model: 'claude-sonnet-5',
  effort: 'high',
  speed: 'fast',
  sessionCapabilityGrants: ['subagents'],
}

describe('SessionManager.forkSession', () => {
  let manager: SessionManager
  let workDir: string

  beforeEach(() => {
    // The constructor creates directories and settings under its workDir
    // (session-manager.ts:98-151); isolate it like the idle-eviction test.
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-fork-'))
    persisted.clear()
    sdkFork.mockReset()
    sdkDelete.mockReset()
    sdkDelete.mockResolvedValue(undefined)
    saveChecked.mockClear()
    persisted.set('src-1', { ...source })
    manager = new SessionManager(workDir, { prewarmEnabled: false, idleEvictionMs: -1, automatedIdleEvictionMs: -1 })
  })

  afterEach(async () => {
    await manager.stopAll()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('copies the transcript via the SDK and records the new id with a checked write', async () => {
    sdkFork.mockResolvedValue({ sessionId: 'fork-1' })

    const id = await manager.forkSession('src-1')

    expect(id).toBe('fork-1')
    expect(sdkFork).toHaveBeenCalledWith('src-1', { dir: '/workspace' })
    const record = persisted.get('fork-1')!
    expect(record.claudeSessionId).toBe('fork-1')
    expect(record.model).toBe('claude-sonnet-5')
    expect(record.effort).toBe('high')
    expect(record.speed).toBe('fast')
    expect(record.sessionCapabilityGrants).toBeUndefined()
    expect(record.createdAt).not.toBe(source.createdAt)
    expect(persisted.get('src-1')).toEqual(source) // source untouched
  })

  it('returns null for an unknown source', async () => {
    expect(await manager.forkSession('nope')).toBeNull()
    expect(sdkFork).not.toHaveBeenCalled()
  })

  it('removes the SDK copy and rethrows when the checked write fails', async () => {
    sdkFork.mockResolvedValue({ sessionId: 'fork-2' })
    saveChecked.mockImplementationOnce(() => { throw new Error('disk full') })

    await expect(manager.forkSession('src-1')).rejects.toThrow('disk full')
    expect(sdkDelete).toHaveBeenCalledWith('fork-2', { dir: '/workspace' })
    expect(persisted.has('fork-2')).toBe(false)
  })

  it('forgets a never-opened persisted session', async () => {
    persisted.set('fork-1', { sessionId: 'fork-1', claudeSessionId: 'fork-1', workingDirectory: '/workspace' })
    expect(await manager.deleteSession('fork-1')).toBe(true)
    expect(persisted.has('fork-1')).toBe(false)
  })

  it('refuses while the source has a live process mid-turn', async () => {
    // Reach into the live map the way the eviction test does.
    ;(manager as any).sessions.set('src-1', {
      session: { id: 'src-1' },
      process: { isRunning: () => true },
      subscribers: new Set(),
      settlement: { isSettled: () => false },
    })

    await expect(manager.forkSession('src-1')).rejects.toBeInstanceOf(SessionBusyError)
    expect(sdkFork).not.toHaveBeenCalled()
  })
})
