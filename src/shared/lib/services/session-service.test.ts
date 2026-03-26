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
  removeMessage,
  removeToolCall,
  getSessionsByScheduledTask,
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
      expect(sessions[0].messageCount).toBe(0)
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

    it('uses fallback name when no metadata', async () => {
      await createSessionFile(
        'test-agent',
        'session-no-meta',
        SAMPLE_JSONL_ENTRIES
      )

      const sessions = await listSessions('test-agent')

      // No metadata name → falls back to 'New Session'
      expect(sessions[0].name).toBe('New Session')
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

    it('returns null when no agents exist', async () => {
      // Ensure agents dir exists but is empty
      await fs.promises.mkdir(path.join(testDir, 'agents'), { recursive: true })

      const result = await findSessionAcrossAgents('any-session')
      expect(result).toBeNull()
    })

    it('finds session in first agent when multiple agents have sessions', async () => {
      await createSessionFile('agent-1', 'shared-session', SAMPLE_JSONL_ENTRIES)

      const result = await findSessionAcrossAgents('shared-session')

      expect(result).not.toBeNull()
      expect(result?.agentSlug).toBe('agent-1')
      expect(result?.session.id).toBe('shared-session')
    })
  })

  // ============================================================================
  // removeMessage Tests
  // ============================================================================

  describe('removeMessage', () => {
    // Helper to read back JSONL entries from disk after a write
    async function readSessionEntries(agentSlug: string, sessionId: string): Promise<any[]> {
      const sessionsDir = path.join(
        testDir,
        'agents',
        agentSlug,
        'workspace',
        '.claude',
        'projects',
        '-workspace'
      )
      const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`)
      const content = await fs.promises.readFile(jsonlPath, 'utf-8')
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    }

    it('removes a simple user message by UUID', async () => {
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi there!' }],
            id: 'msg-asst-1',
          },
        },
        {
          type: 'user',
          uuid: 'user-2',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: { role: 'user', content: 'How are you?' },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'user-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(2)
      expect(remaining[0].uuid).toBe('asst-1')
      expect(remaining[1].uuid).toBe('user-2')
    })

    it('removes an assistant message and associated tool_result entries', async () => {
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'List files' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me list them.' },
              { type: 'tool_use', id: 'tool-call-1', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-asst-1',
          },
        },
        {
          type: 'user',
          uuid: 'tool-result-1',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-call-1', content: 'file1.txt\nfile2.txt' },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'asst-2',
          parentUuid: 'tool-result-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:03.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done!' }],
            id: 'msg-asst-2',
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'asst-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(2)
      expect(remaining[0].uuid).toBe('user-1')
      expect(remaining[1].uuid).toBe('asst-2')
      // The tool_result user entry should be removed too
      expect(remaining.find((e: any) => e.uuid === 'tool-result-1')).toBeUndefined()
    })

    it('removes an assistant message with multiple tool_use blocks and all corresponding tool_results', async () => {
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Do multiple things' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will run two commands.' },
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
              { type: 'tool_use', id: 'tc-2', name: 'Bash', input: { command: 'pwd' } },
            ],
            id: 'msg-asst-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-1',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'file1.txt' },
              { type: 'tool_result', tool_use_id: 'tc-2', content: '/workspace' },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'asst-2',
          parentUuid: 'tr-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:03.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'All done!' }],
            id: 'msg-asst-2',
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'asst-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(2)
      expect(remaining[0].uuid).toBe('user-1')
      expect(remaining[1].uuid).toBe('asst-2')
      // Both tool_result entries removed
      expect(remaining.find((e: any) => e.uuid === 'tr-1')).toBeUndefined()
    })

    it('keeps a user entry that has mixed tool_result and other content blocks (only some tool_results match)', async () => {
      // The user entry has a tool_result for tc-1 (to be removed) AND a tool_result for tc-unrelated (should stay)
      // Since not ALL blocks are tool_results matching removed IDs, the entry stays
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Do stuff' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-asst-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-mixed',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'result1' },
              { type: 'tool_result', tool_use_id: 'tc-unrelated', content: 'other-result' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'asst-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      // The user entry should remain because it has a tool_result for tc-unrelated
      // removeMessage only removes entries where EVERY block is a tool_result matching the removed IDs
      expect(remaining.length).toBe(2)
      expect(remaining[0].uuid).toBe('user-1')
      expect(remaining[1].uuid).toBe('tr-mixed')
      // The entry still has both blocks (removeMessage doesn't partial-remove blocks from user entries)
      expect(remaining[1].message.content).toHaveLength(2)
    })

    it('removes user entry when ALL its blocks are tool_results matching removed tool calls', async () => {
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Do stuff' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
              { type: 'tool_use', id: 'tc-2', name: 'Bash', input: { command: 'pwd' } },
            ],
            id: 'msg-asst-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-all-match',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'result1' },
              { type: 'tool_result', tool_use_id: 'tc-2', content: 'result2' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'asst-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(1)
      expect(remaining[0].uuid).toBe('user-1')
    })

    it('returns false when message UUID is not found', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)

      const result = await removeMessage('test-agent', 'sess-1', 'nonexistent-uuid')
      expect(result).toBe(false)

      // Verify no changes were made
      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(SAMPLE_JSONL_ENTRIES.length)
    })

    it('returns false when session file does not exist', async () => {
      await createSessionsDir('test-agent')

      const result = await removeMessage('test-agent', 'nonexistent-session', 'any-uuid')
      expect(result).toBe(false)
    })

    it('removes the first message in the session', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)

      const firstUuid = SAMPLE_JSONL_ENTRIES[0].uuid
      const result = await removeMessage('test-agent', 'sess-1', firstUuid)
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(3)
      expect(remaining[0].uuid).toBe(SAMPLE_JSONL_ENTRIES[1].uuid)
    })

    it('removes the last message in the session', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)

      const lastUuid = SAMPLE_JSONL_ENTRIES[SAMPLE_JSONL_ENTRIES.length - 1].uuid
      const result = await removeMessage('test-agent', 'sess-1', lastUuid)
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(3)
      expect(remaining[remaining.length - 1].uuid).toBe(SAMPLE_JSONL_ENTRIES[2].uuid)
    })

    it('removes the only message in the session (results in empty file)', async () => {
      const singleEntry = [
        {
          type: 'user',
          uuid: 'only-msg',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', singleEntry)

      const result = await removeMessage('test-agent', 'sess-1', 'only-msg')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(0)
    })

    it('removes an assistant message with no tool_use blocks (text-only)', async () => {
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi there!' }],
            id: 'msg-asst-1',
          },
        },
        {
          type: 'user',
          uuid: 'user-2',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: { role: 'user', content: 'Thanks' },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'asst-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(2)
      expect(remaining[0].uuid).toBe('user-1')
      expect(remaining[1].uuid).toBe('user-2')
    })

    it('removes all assistant entries sharing the same message.id', async () => {
      // Simulate Claude SDK splitting a long assistant message into multiple JSONL entries
      // with the same message.id
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Do many things' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1-part-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Part 1 of my response' },
              { type: 'tool_use', id: 'tc-A', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'shared-msg-id',
          },
        },
        {
          type: 'user',
          uuid: 'tr-A',
          parentUuid: 'asst-1-part-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-A', content: 'files' },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'asst-1-part-2',
          parentUuid: 'tr-A',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:03.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Part 2 continuing' },
              { type: 'tool_use', id: 'tc-B', name: 'Bash', input: { command: 'cat file1' } },
            ],
            id: 'shared-msg-id', // Same message ID!
          },
        },
        {
          type: 'user',
          uuid: 'tr-B',
          parentUuid: 'asst-1-part-2',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:04.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-B', content: 'file content' },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'asst-2',
          parentUuid: 'tr-B',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:05.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'All done!' }],
            id: 'different-msg-id',
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      // Remove using the UUID of the first part
      const result = await removeMessage('test-agent', 'sess-1', 'asst-1-part-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      // Should remove: asst-1-part-1, asst-1-part-2 (same msg id), tr-A, tr-B (tool results)
      expect(remaining.length).toBe(2)
      expect(remaining[0].uuid).toBe('user-1')
      expect(remaining[1].uuid).toBe('asst-2')
    })

    it('preserves non-message entries (file-history-snapshot, system)', async () => {
      const entries = [
        {
          type: 'system',
          uuid: 'sys-1',
          subtype: 'init',
          content: 'Session started',
          isMeta: true,
          timestamp: '2026-01-24T01:00:00.000Z',
        },
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'file-history-snapshot',
          messageId: 'msg-1',
          snapshot: { messageId: 'msg-1', trackedFileBackups: {}, timestamp: '2026-01-24T01:00:02.000Z' },
        },
        {
          type: 'user',
          uuid: 'user-2',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:03.000Z',
          message: { role: 'user', content: 'Bye' },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'user-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(3)
      expect(remaining[0].type).toBe('system')
      expect(remaining[1].type).toBe('file-history-snapshot')
      expect(remaining[2].uuid).toBe('user-2')
    })

    it('handles assistant message with string content (not array)', async () => {
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: 'Just a plain string response',
            id: 'msg-asst-1',
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'asst-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(1)
      expect(remaining[0].uuid).toBe('user-1')
    })

    it('does not remove unrelated user entries with tool_result content', async () => {
      // Two separate assistant messages with tool calls; remove only one
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Step 1' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-A', name: 'Bash', input: { command: 'echo A' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-A',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-A', content: 'A' },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'asst-2',
          parentUuid: 'tr-A',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:03.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-B', name: 'Bash', input: { command: 'echo B' } },
            ],
            id: 'msg-2',
          },
        },
        {
          type: 'user',
          uuid: 'tr-B',
          parentUuid: 'asst-2',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:04.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-B', content: 'B' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      // Remove only asst-1 (tool call tc-A)
      const result = await removeMessage('test-agent', 'sess-1', 'asst-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(3)
      expect(remaining[0].uuid).toBe('user-1')
      expect(remaining[1].uuid).toBe('asst-2')
      expect(remaining[2].uuid).toBe('tr-B')
      // tr-B for tc-B should remain untouched
    })

    it('handles removing a user message that is a tool_result entry', async () => {
      // A user-type entry that contains tool_result blocks can also be targeted by uuid
      const entries = [
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-1',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'output' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      // Remove the tool_result user entry directly by its uuid
      const result = await removeMessage('test-agent', 'sess-1', 'tr-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(1)
      expect(remaining[0].uuid).toBe('asst-1')
    })

    it('uses the SAMPLE_JSONL_WITH_TOOL_USE fixture (no message.id means no tool_result cleanup)', async () => {
      // IMPORTANT: The fixture entries do NOT have message.id on assistant messages.
      // Without message.id, removeMessage only removes the target entry by uuid;
      // it does NOT collect tool_use IDs and does NOT remove associated tool_result entries.
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_WITH_TOOL_USE)

      // Remove the assistant message with tool_use
      const result = await removeMessage('test-agent', 'sess-1', 'assistant-msg-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      // Only assistant-msg-1 is removed; tool-result-1 stays because no message.id to trigger cleanup
      expect(remaining.length).toBe(3)
      expect(remaining[0].uuid).toBe('user-msg-1')
      expect(remaining[1].uuid).toBe('tool-result-1')
      expect(remaining[2].uuid).toBe('assistant-msg-2')
    })

    it('handles assistant message without message.id field', async () => {
      // If message.id is undefined, removal should still work via uuid match
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            // No id field
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'asst-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(1)
      expect(remaining[0].uuid).toBe('user-1')
    })

    it('writes valid JSONL after removal (each line is valid JSON)', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)

      await removeMessage('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES[1].uuid)

      const sessionsDir = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        '.claude',
        'projects',
        '-workspace'
      )
      const jsonlPath = path.join(sessionsDir, 'sess-1.jsonl')
      const content = await fs.promises.readFile(jsonlPath, 'utf-8')

      // Should end with newline
      expect(content.endsWith('\n')).toBe(true)

      // Each non-empty line should be valid JSON
      const lines = content.split('\n').filter((l) => l.trim())
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    })
  })

  // ============================================================================
  // removeToolCall Tests
  // ============================================================================

  describe('removeToolCall', () => {
    // Helper to read back JSONL entries from disk after a write
    async function readSessionEntries(agentSlug: string, sessionId: string): Promise<any[]> {
      const sessionsDir = path.join(
        testDir,
        'agents',
        agentSlug,
        'workspace',
        '.claude',
        'projects',
        '-workspace'
      )
      const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`)
      const content = await fs.promises.readFile(jsonlPath, 'utf-8')
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    }

    it('removes a specific tool_use block from an assistant entry', async () => {
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Do stuff' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Running commands' },
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
              { type: 'tool_use', id: 'tc-2', name: 'Bash', input: { command: 'pwd' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-1',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'file1.txt' },
              { type: 'tool_result', tool_use_id: 'tc-2', content: '/workspace' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(3)

      // Assistant entry should still exist but without tc-1
      const asst = remaining[1]
      expect(asst.uuid).toBe('asst-1')
      expect(asst.message.content).toHaveLength(2)
      expect(asst.message.content[0]).toEqual({ type: 'text', text: 'Running commands' })
      expect(asst.message.content[1]).toEqual({ type: 'tool_use', id: 'tc-2', name: 'Bash', input: { command: 'pwd' } })

      // User entry should still exist but without tc-1 result
      const tr = remaining[2]
      expect(tr.uuid).toBe('tr-1')
      expect(tr.message.content).toHaveLength(1)
      expect(tr.message.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tc-2', content: '/workspace' })
    })

    it('removes the corresponding tool_result in the user entry', async () => {
      const entries = [
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check' },
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-1',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'files' },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'asst-2',
          parentUuid: 'tr-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done' }],
            id: 'msg-2',
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      // assistant entry keeps the text block, user entry is dropped (only had tool_result for tc-1)
      expect(remaining.length).toBe(2)
      expect(remaining[0].uuid).toBe('asst-1')
      expect(remaining[0].message.content).toEqual([{ type: 'text', text: 'Let me check' }])
      expect(remaining[1].uuid).toBe('asst-2')
    })

    it('removes the only tool_use from assistant entry (entry should be dropped)', async () => {
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Do it' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-only', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-only',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-only', content: 'output' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-only')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      // Both assistant and user entries should be dropped (no remaining content)
      expect(remaining.length).toBe(1)
      expect(remaining[0].uuid).toBe('user-1')
    })

    it('removes one of multiple tool_use blocks (others remain)', async () => {
      const entries = [
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
              { type: 'tool_use', id: 'tc-2', name: 'Bash', input: { command: 'pwd' } },
              { type: 'tool_use', id: 'tc-3', name: 'Bash', input: { command: 'whoami' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-1',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'files' },
              { type: 'tool_result', tool_use_id: 'tc-2', content: '/home' },
              { type: 'tool_result', tool_use_id: 'tc-3', content: 'root' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-2')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(2)

      // Assistant: tc-1 and tc-3 remain
      const asst = remaining[0]
      expect(asst.message.content).toHaveLength(2)
      expect(asst.message.content[0].id).toBe('tc-1')
      expect(asst.message.content[1].id).toBe('tc-3')

      // User: tc-1 and tc-3 results remain
      const tr = remaining[1]
      expect(tr.message.content).toHaveLength(2)
      expect(tr.message.content[0].tool_use_id).toBe('tc-1')
      expect(tr.message.content[1].tool_use_id).toBe('tc-3')
    })

    it('returns false when tool call ID is not found', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_WITH_TOOL_USE)

      const result = await removeToolCall('test-agent', 'sess-1', 'nonexistent-tool-id')
      expect(result).toBe(false)
    })

    it('returns false when session file does not exist', async () => {
      await createSessionsDir('test-agent')

      const result = await removeToolCall('test-agent', 'nonexistent-session', 'any-tool-id')
      expect(result).toBe(false)
    })

    it('keeps user entry that has other content blocks alongside the removed tool_result', async () => {
      // If a user entry has both a matching tool_result and other non-tool_result content
      // (or unrelated tool_results), only the matching tool_result should be removed
      const entries = [
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-mixed',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'result' },
              { type: 'tool_result', tool_use_id: 'tc-other', content: 'other result' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      // User entry should remain with only tc-other result
      expect(remaining.length).toBe(1) // assistant entry is dropped (no remaining content)
      expect(remaining[0].uuid).toBe('tr-mixed')
      expect(remaining[0].message.content).toHaveLength(1)
      expect(remaining[0].message.content[0].tool_use_id).toBe('tc-other')
    })

    it('preserves non-message entries', async () => {
      const entries = [
        {
          type: 'system',
          uuid: 'sys-1',
          subtype: 'init',
          content: 'Session started',
          isMeta: true,
          timestamp: '2026-01-24T01:00:00.000Z',
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-1',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'output' },
            ],
          },
        },
        {
          type: 'file-history-snapshot',
          messageId: 'msg-1',
          snapshot: { messageId: 'msg-1', trackedFileBackups: {}, timestamp: '2026-01-24T01:00:03.000Z' },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      // System and file-history-snapshot entries should be preserved
      expect(remaining.length).toBe(2)
      expect(remaining[0].type).toBe('system')
      expect(remaining[1].type).toBe('file-history-snapshot')
    })

    it('uses the SAMPLE_JSONL_WITH_TOOL_USE fixture correctly', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_WITH_TOOL_USE)

      const result = await removeToolCall('test-agent', 'sess-1', 'tool-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      // tool-result-1 user entry should be removed (only had tool_result for tool-1)
      // assistant-msg-1 should remain with just the text block
      expect(remaining.length).toBe(3)
      expect(remaining[0].uuid).toBe('user-msg-1')
      expect(remaining[1].uuid).toBe('assistant-msg-1')
      expect(remaining[1].message.content).toEqual([
        { type: 'text', text: "I'll list the files for you." },
      ])
      expect(remaining[2].uuid).toBe('assistant-msg-2')
    })

    it('writes valid JSONL after removal', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_WITH_TOOL_USE)

      await removeToolCall('test-agent', 'sess-1', 'tool-1')

      const sessionsDir = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        '.claude',
        'projects',
        '-workspace'
      )
      const jsonlPath = path.join(sessionsDir, 'sess-1.jsonl')
      const content = await fs.promises.readFile(jsonlPath, 'utf-8')

      expect(content.endsWith('\n')).toBe(true)

      const lines = content.split('\n').filter((l) => l.trim())
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    })

    it('writes empty string when all entries are removed', async () => {
      // Only an assistant with one tool_use and the corresponding tool_result
      const entries = [
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-only', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-only',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-only', content: 'output' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-only')
      expect(result).toBe(true)

      const sessionsDir = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        '.claude',
        'projects',
        '-workspace'
      )
      const jsonlPath = path.join(sessionsDir, 'sess-1.jsonl')
      const content = await fs.promises.readFile(jsonlPath, 'utf-8')
      // Empty file should be just empty string (no trailing newline since filtered.length == 0)
      expect(content).toBe('')
    })

    it('handles tool call in assistant but no matching tool_result in any user entry', async () => {
      // Tool_use exists but tool_result was never written (e.g., interrupted session)
      const entries = [
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Running...' },
              { type: 'tool_use', id: 'tc-orphan', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-1',
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-orphan')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(1)
      expect(remaining[0].uuid).toBe('asst-1')
      expect(remaining[0].message.content).toEqual([{ type: 'text', text: 'Running...' }])
    })

    it('does not modify entries for unrelated tool calls', async () => {
      const entries = [
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-keep', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-keep',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-keep', content: 'output' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-nonexistent')
      expect(result).toBe(false)

      // Entries should be unchanged
      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(2)
      expect(remaining[0].message.content).toHaveLength(1)
      expect(remaining[1].message.content).toHaveLength(1)
    })

    it('handles user entries with string content (not array) gracefully', async () => {
      // A user entry with string content should be passed through unchanged
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Plain text user message' },
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
            ],
            id: 'msg-1',
          },
        },
        {
          type: 'user',
          uuid: 'tr-1',
          parentUuid: 'asst-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'output' },
            ],
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeToolCall('test-agent', 'sess-1', 'tc-1')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      // user-1 with string content should be untouched
      expect(remaining.length).toBe(1)
      expect(remaining[0].uuid).toBe('user-1')
      expect(remaining[0].message.content).toBe('Plain text user message')
    })
  })

  // ============================================================================
  // getSessionsByScheduledTask Tests
  // ============================================================================

  describe('getSessionsByScheduledTask', () => {
    it('returns empty array when no sessions match the scheduled task', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'sess-1': {
          name: 'Regular Session',
          createdAt: '2026-01-24T01:00:00.000Z',
        },
      })

      const sessions = await getSessionsByScheduledTask('test-agent', 'task-abc')
      expect(sessions).toEqual([])
    })

    it('returns sessions created by the specified scheduled task', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'sess-2', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'sess-1': {
          name: 'Scheduled Run 1',
          createdAt: '2026-01-24T01:00:00.000Z',
          scheduledTaskId: 'task-abc',
          isScheduledExecution: true,
        },
        'sess-2': {
          name: 'Regular Session',
          createdAt: '2026-01-24T02:00:00.000Z',
        },
      })

      const sessions = await getSessionsByScheduledTask('test-agent', 'task-abc')
      expect(sessions.length).toBe(1)
      expect(sessions[0].id).toBe('sess-1')
    })

    it('returns multiple sessions for the same scheduled task', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'sess-2', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'sess-3', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'sess-1': {
          name: 'Run 1',
          createdAt: '2026-01-24T01:00:00.000Z',
          scheduledTaskId: 'task-abc',
          isScheduledExecution: true,
        },
        'sess-2': {
          name: 'Run 2',
          createdAt: '2026-01-24T02:00:00.000Z',
          scheduledTaskId: 'task-abc',
          isScheduledExecution: true,
        },
        'sess-3': {
          name: 'Other Task Run',
          createdAt: '2026-01-24T03:00:00.000Z',
          scheduledTaskId: 'task-xyz',
          isScheduledExecution: true,
        },
      })

      const sessions = await getSessionsByScheduledTask('test-agent', 'task-abc')
      expect(sessions.length).toBe(2)
      const ids = sessions.map((s) => s.id)
      expect(ids).toContain('sess-1')
      expect(ids).toContain('sess-2')
    })

    it('returns empty array when no sessions exist for the agent', async () => {
      await createSessionsDir('test-agent')

      const sessions = await getSessionsByScheduledTask('test-agent', 'task-abc')
      expect(sessions).toEqual([])
    })
  })
})
