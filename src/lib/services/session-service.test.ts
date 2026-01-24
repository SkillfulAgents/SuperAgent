import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  SAMPLE_SESSION_METADATA,
  SAMPLE_JSONL_ENTRIES,
  SAMPLE_JSONL_WITH_TOOL_USE,
  toJsonl,
} from './__fixtures__/test-data'

import {
  listSessions,
  getSession,
  getSessionMessages,
  deleteSession,
  updateSessionName,
  sessionExists,
  registerSession,
  isSessionRegistered,
  updateSessionMetadata,
  getSessionMetadata,
  ensureSessionsDirectory,
  findSessionAcrossAgents,
} from './session-service'

describe('session-service', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    // Create a unique temp directory
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'session-service-test-')
    )

    // Store original env and set test data dir
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    // Restore env
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }

    // Clean up temp directory
    await fs.promises.rm(testDir, { recursive: true, force: true })

    // Reset module cache
    vi.resetModules()
  })

  // Helper to create session directory structure
  async function createSessionsDir(agentSlug: string): Promise<string> {
    const sessionsDir = path.join(
      testDir,
      'agents',
      agentSlug,
      'workspace',
      '.claude',
      'projects',
      '-workspace'
    )
    await fs.promises.mkdir(sessionsDir, { recursive: true })
    return sessionsDir
  }

  // Helper to create a session JSONL file
  async function createSessionFile(
    agentSlug: string,
    sessionId: string,
    entries: object[]
  ): Promise<void> {
    const sessionsDir = await createSessionsDir(agentSlug)
    const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`)
    await fs.promises.writeFile(jsonlPath, toJsonl(entries))
  }

  // Helper to create session metadata
  async function createSessionMetadata(
    agentSlug: string,
    metadata: Record<string, object>
  ): Promise<void> {
    const workspaceDir = path.join(testDir, 'agents', agentSlug, 'workspace')
    await fs.promises.mkdir(workspaceDir, { recursive: true })
    await fs.promises.writeFile(
      path.join(workspaceDir, 'session-metadata.json'),
      JSON.stringify(metadata, null, 2)
    )
  }

  // ============================================================================
  // Session Metadata Tests
  // ============================================================================

  describe('registerSession', () => {
    it('creates session metadata entry', async () => {
      // Ensure workspace exists
      await fs.promises.mkdir(
        path.join(testDir, 'agents', 'test-agent', 'workspace'),
        { recursive: true }
      )

      await registerSession('test-agent', 'session-123', 'My Session')

      const metadata = await getSessionMetadata('test-agent', 'session-123')
      expect(metadata?.name).toBe('My Session')
      expect(metadata?.createdAt).toBeDefined()
    })

    it('uses default name when not provided', async () => {
      await fs.promises.mkdir(
        path.join(testDir, 'agents', 'test-agent', 'workspace'),
        { recursive: true }
      )

      await registerSession('test-agent', 'session-123')

      const metadata = await getSessionMetadata('test-agent', 'session-123')
      expect(metadata?.name).toBe('New Session')
    })
  })

  describe('isSessionRegistered', () => {
    it('returns false when session not registered', async () => {
      const result = await isSessionRegistered('test-agent', 'nonexistent')
      expect(result).toBe(false)
    })

    it('returns true when session is registered', async () => {
      await createSessionMetadata('test-agent', SAMPLE_SESSION_METADATA)

      const result = await isSessionRegistered(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5'
      )
      expect(result).toBe(true)
    })
  })

  describe('updateSessionMetadata', () => {
    it('updates session name', async () => {
      await createSessionMetadata('test-agent', SAMPLE_SESSION_METADATA)

      await updateSessionMetadata(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5',
        { name: 'Updated Name' }
      )

      const metadata = await getSessionMetadata(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5'
      )
      expect(metadata?.name).toBe('Updated Name')
      // Should preserve createdAt
      expect(metadata?.createdAt).toBe('2026-01-24T01:30:58.665Z')
    })

    it('adds starred status', async () => {
      await createSessionMetadata('test-agent', SAMPLE_SESSION_METADATA)

      await updateSessionMetadata(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5',
        { starred: true }
      )

      const metadata = await getSessionMetadata(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5'
      )
      expect(metadata?.starred).toBe(true)
    })
  })

  describe('getSessionMetadata', () => {
    it('returns null for non-existent session', async () => {
      const metadata = await getSessionMetadata('test-agent', 'nonexistent')
      expect(metadata).toBeNull()
    })

    it('returns metadata for existing session', async () => {
      await createSessionMetadata('test-agent', SAMPLE_SESSION_METADATA)

      const metadata = await getSessionMetadata(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5'
      )
      expect(metadata?.name).toBe('Simple Math Question')
    })
  })

  // ============================================================================
  // Session Operations
  // ============================================================================

  describe('listSessions', () => {
    it('returns empty array when no sessions exist', async () => {
      await createSessionsDir('test-agent')

      const sessions = await listSessions('test-agent')
      expect(sessions).toEqual([])
    })

    it('lists sessions from JSONL files', async () => {
      await createSessionFile(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5',
        SAMPLE_JSONL_ENTRIES
      )

      const sessions = await listSessions('test-agent')

      expect(sessions.length).toBe(1)
      expect(sessions[0].id).toBe('519f8756-a16e-41ff-99de-9fe599dedae5')
      expect(sessions[0].messageCount).toBe(4)
    })

    it('uses custom name from metadata', async () => {
      await createSessionFile(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5',
        SAMPLE_JSONL_ENTRIES
      )
      // Only include metadata for the session we have a JSONL file for
      await createSessionMetadata('test-agent', {
        '519f8756-a16e-41ff-99de-9fe599dedae5': {
          name: 'Simple Math Question',
          createdAt: '2026-01-24T01:30:58.665Z',
        },
      })

      const sessions = await listSessions('test-agent')

      expect(sessions[0].name).toBe('Simple Math Question')
    })

    it('generates name from first message when no metadata', async () => {
      await createSessionFile(
        'test-agent',
        'session-no-meta',
        SAMPLE_JSONL_ENTRIES
      )

      const sessions = await listSessions('test-agent')

      // First user message is "Whats 1+1?"
      expect(sessions[0].name).toBe('Whats 1+1?')
    })

    it('includes registered sessions without JSONL files', async () => {
      // Create sessions dir but no JSONL
      await createSessionsDir('test-agent')
      await createSessionMetadata('test-agent', {
        'pending-session': {
          name: 'Pending Session',
          createdAt: '2026-01-24T10:00:00.000Z',
        },
      })

      const sessions = await listSessions('test-agent')

      expect(sessions.length).toBe(1)
      expect(sessions[0].id).toBe('pending-session')
      expect(sessions[0].name).toBe('Pending Session')
      expect(sessions[0].messageCount).toBe(0)
    })

    it('sorts sessions by last activity (newest first)', async () => {
      const oldEntries = [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-20T00:00:00.000Z',
          message: { role: 'user', content: 'Old message' },
        },
      ]
      const newEntries = [
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-01-25T00:00:00.000Z',
          message: { role: 'user', content: 'New message' },
        },
      ]

      await createSessionFile('test-agent', 'old-session', oldEntries)
      await createSessionFile('test-agent', 'new-session', newEntries)

      const sessions = await listSessions('test-agent')

      expect(sessions[0].id).toBe('new-session')
      expect(sessions[1].id).toBe('old-session')
    })
  })

  describe('getSession', () => {
    it('returns null for non-existent session', async () => {
      await createSessionsDir('test-agent')

      const session = await getSession('test-agent', 'nonexistent')
      expect(session).toBeNull()
    })

    it('returns session info for existing session', async () => {
      await createSessionFile(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5',
        SAMPLE_JSONL_ENTRIES
      )
      await createSessionMetadata('test-agent', SAMPLE_SESSION_METADATA)

      const session = await getSession(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5'
      )

      expect(session).not.toBeNull()
      expect(session?.id).toBe('519f8756-a16e-41ff-99de-9fe599dedae5')
      expect(session?.agentSlug).toBe('test-agent')
      expect(session?.name).toBe('Simple Math Question')
      expect(session?.messageCount).toBe(4)
    })

    it('calculates correct timestamps', async () => {
      await createSessionFile(
        'test-agent',
        'test-session',
        SAMPLE_JSONL_ENTRIES
      )

      const session = await getSession('test-agent', 'test-session')

      expect(session?.createdAt.toISOString()).toBe('2026-01-24T01:30:58.661Z')
      expect(session?.lastActivityAt.toISOString()).toBe(
        '2026-01-24T01:31:19.827Z'
      )
    })
  })

  describe('getSessionMessages', () => {
    it('returns empty array for non-existent session', async () => {
      await createSessionsDir('test-agent')

      const messages = await getSessionMessages('test-agent', 'nonexistent')
      expect(messages).toEqual([])
    })

    it('returns message entries from JSONL', async () => {
      await createSessionFile(
        'test-agent',
        'test-session',
        SAMPLE_JSONL_ENTRIES
      )

      const messages = await getSessionMessages('test-agent', 'test-session')

      expect(messages.length).toBe(4)
      expect(messages[0].type).toBe('user')
      expect(messages[1].type).toBe('assistant')
    })

    it('filters out non-message entries', async () => {
      const entriesWithMeta = [
        { type: 'queue-operation', operation: 'dequeue', timestamp: '...' },
        ...SAMPLE_JSONL_ENTRIES,
        { type: 'file-history-snapshot', messageId: '123', snapshot: {} },
      ]

      await createSessionFile('test-agent', 'test-session', entriesWithMeta)

      const messages = await getSessionMessages('test-agent', 'test-session')

      expect(messages.length).toBe(4)
      expect(messages.every((m) => m.type === 'user' || m.type === 'assistant')).toBe(
        true
      )
    })

    it('handles sessions with tool use', async () => {
      await createSessionFile(
        'test-agent',
        'tool-session',
        SAMPLE_JSONL_WITH_TOOL_USE
      )

      const messages = await getSessionMessages('test-agent', 'tool-session')

      expect(messages.length).toBe(4)

      // Check tool use message
      const toolUseMsg = messages[1]
      expect(toolUseMsg.type).toBe('assistant')

      // Check tool result message
      const toolResultMsg = messages[2]
      expect(toolResultMsg.type).toBe('user')
      expect(toolResultMsg.toolUseResult).toBeDefined()
      expect(toolResultMsg.toolUseResult?.stdout).toBe(
        'file1.txt\nfile2.txt\nREADME.md'
      )
    })
  })

  describe('deleteSession', () => {
    it('returns false for non-existent session', async () => {
      await createSessionsDir('test-agent')

      const result = await deleteSession('test-agent', 'nonexistent')
      expect(result).toBe(false)
    })

    it('deletes session JSONL file', async () => {
      await createSessionFile(
        'test-agent',
        'test-session',
        SAMPLE_JSONL_ENTRIES
      )

      const result = await deleteSession('test-agent', 'test-session')

      expect(result).toBe(true)
      expect(await sessionExists('test-agent', 'test-session')).toBe(false)
    })

    it('removes session from metadata', async () => {
      await createSessionFile(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5',
        SAMPLE_JSONL_ENTRIES
      )
      await createSessionMetadata('test-agent', SAMPLE_SESSION_METADATA)

      await deleteSession('test-agent', '519f8756-a16e-41ff-99de-9fe599dedae5')

      const metadata = await getSessionMetadata(
        'test-agent',
        '519f8756-a16e-41ff-99de-9fe599dedae5'
      )
      expect(metadata).toBeNull()
    })
  })

  describe('updateSessionName', () => {
    it('updates session name in metadata', async () => {
      await createSessionFile(
        'test-agent',
        'test-session',
        SAMPLE_JSONL_ENTRIES
      )

      await updateSessionName('test-agent', 'test-session', 'New Name')

      const metadata = await getSessionMetadata('test-agent', 'test-session')
      expect(metadata?.name).toBe('New Name')
    })
  })

  describe('sessionExists', () => {
    it('returns false for non-existent session', async () => {
      await createSessionsDir('test-agent')

      const exists = await sessionExists('test-agent', 'nonexistent')
      expect(exists).toBe(false)
    })

    it('returns true for existing session', async () => {
      await createSessionFile(
        'test-agent',
        'test-session',
        SAMPLE_JSONL_ENTRIES
      )

      const exists = await sessionExists('test-agent', 'test-session')
      expect(exists).toBe(true)
    })
  })

  describe('ensureSessionsDirectory', () => {
    it('creates sessions directory structure', async () => {
      await ensureSessionsDirectory('test-agent')

      const sessionsDir = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        '.claude',
        'projects',
        '-workspace'
      )
      const stat = await fs.promises.stat(sessionsDir)
      expect(stat.isDirectory()).toBe(true)
    })

    it('does not throw if directory already exists', async () => {
      await createSessionsDir('test-agent')

      await expect(ensureSessionsDirectory('test-agent')).resolves.toBeUndefined()
    })
  })

  describe('findSessionAcrossAgents', () => {
    it('returns null when session not found', async () => {
      await createSessionsDir('agent-1')
      await createSessionsDir('agent-2')

      const result = await findSessionAcrossAgents('nonexistent-session')
      expect(result).toBeNull()
    })

    it('finds session and returns agent slug', async () => {
      await createSessionFile('agent-1', 'session-in-1', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('agent-2', 'session-in-2', SAMPLE_JSONL_ENTRIES)

      const result = await findSessionAcrossAgents('session-in-2')

      expect(result).not.toBeNull()
      expect(result?.agentSlug).toBe('agent-2')
      expect(result?.session.id).toBe('session-in-2')
    })
  })
})
