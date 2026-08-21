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
  listSessionsByIds,
  getSession,
  getSessionMessages,
  getSessionMessagesPage,
  getSessionMessagesDelta,
  deleteSession,
  deleteSessionsBatch,
  readSessionMetadata,
  updateSessionName,
  sessionExists,
  sessionIsKnown,
  registerSession,
  isSessionRegistered,
  updateSessionMetadata,
  getSessionMetadata,
  ensureSessionsDirectory,
  findSessionAcrossAgents,
  removeMessage,
  removeToolCall,
  getSessionsByScheduledTask,
  getSessionForScheduledExecution,
  getSessionsByWebhookTrigger,
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

    it('stores initial metadata in the same registration write', async () => {
      await fs.promises.mkdir(
        path.join(testDir, 'agents', 'test-agent', 'workspace'),
        { recursive: true }
      )

      await registerSession('test-agent', 'session-123', 'Scheduled Run', {
        isScheduledExecution: true,
        scheduledTaskId: 'task-abc',
        scheduledTaskName: 'Daily report',
        scheduledExecutionAt: '2026-01-24T02:00:00.000Z',
      })

      const metadata = await getSessionMetadata('test-agent', 'session-123')
      expect(metadata).toMatchObject({
        name: 'Scheduled Run',
        isScheduledExecution: true,
        scheduledTaskId: 'task-abc',
        scheduledTaskName: 'Daily report',
        scheduledExecutionAt: '2026-01-24T02:00:00.000Z',
      })
      expect(metadata?.createdAt).toBeDefined()
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

    it('excludes scheduled/webhook/x-agent sessions when excludeAutomated is set', async () => {
      await createSessionFile('test-agent', 'manual-session', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'scheduled-session', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'webhook-session', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'x-agent-session', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'manual-session': { name: 'Manual' },
        'scheduled-session': { name: 'Scheduled', isScheduledExecution: true, scheduledTaskId: 'task-1' },
        'webhook-session': { name: 'Webhook', isWebhookExecution: true, webhookTriggerId: 'trigger-1' },
        'x-agent-session': { name: 'X-Agent', invokedByAgentSlug: 'caller-agent' },
      })

      const allSessions = await listSessions('test-agent')
      expect(allSessions.length).toBe(4)

      const filtered = await listSessions('test-agent', { excludeAutomated: true })
      expect(filtered.length).toBe(1)
      expect(filtered[0].name).toBe('Manual')
    })

    it('excludes automated metadata-only sessions (no JSONL) when excludeAutomated is set', async () => {
      await createSessionsDir('test-agent')
      await createSessionMetadata('test-agent', {
        'manual-pending': { name: 'Manual Pending', createdAt: '2026-01-24T10:00:00.000Z' },
        'scheduled-pending': { name: 'Scheduled Pending', createdAt: '2026-01-24T11:00:00.000Z', isScheduledExecution: true, scheduledTaskId: 'task-2' },
      })

      const filtered = await listSessions('test-agent', { excludeAutomated: true })
      expect(filtered.length).toBe(1)
      expect(filtered[0].name).toBe('Manual Pending')
    })

    it('includes promoted automated sessions when excludeAutomated is set', async () => {
      await createSessionFile('test-agent', 'manual-session', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'promoted-session', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'still-automated', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'manual-session': { name: 'Manual' },
        'promoted-session': {
          name: 'Promoted',
          isScheduledExecution: true,
          scheduledTaskId: 'task-1',
          promotedToInteractive: true,
        },
        'still-automated': {
          name: 'Still Automated',
          isScheduledExecution: true,
          scheduledTaskId: 'task-2',
        },
      })

      const filtered = await listSessions('test-agent', { excludeAutomated: true })
      expect(filtered.length).toBe(2)
      const names = filtered.map(s => s.name)
      expect(names).toContain('Manual')
      expect(names).toContain('Promoted')
      expect(names).not.toContain('Still Automated')
    })

    it('includes promoted metadata-only sessions (no JSONL) when excludeAutomated is set', async () => {
      await createSessionsDir('test-agent')
      await createSessionMetadata('test-agent', {
        'promoted-pending': {
          name: 'Promoted Pending',
          createdAt: '2026-01-24T10:00:00.000Z',
          isWebhookExecution: true,
          webhookTriggerId: 'trigger-1',
          promotedToInteractive: true,
        },
        'automated-pending': {
          name: 'Automated Pending',
          createdAt: '2026-01-24T11:00:00.000Z',
          isWebhookExecution: true,
          webhookTriggerId: 'trigger-2',
        },
      })

      const filtered = await listSessions('test-agent', { excludeAutomated: true })
      expect(filtered.length).toBe(1)
      expect(filtered[0].name).toBe('Promoted Pending')
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

    it('returns an empty session for a registered session with no JSONL yet', async () => {
      // A just-created session is registered in metadata before the agent
      // streams its first message (which is what writes the JSONL). getSession
      // must report it as existing (empty) — parity with listSessions — rather
      // than 404ing a session that genuinely exists.
      await createSessionsDir('test-agent')
      await createSessionMetadata('test-agent', {
        'settling-session': {
          name: 'Brand New',
          createdAt: '2026-06-18T12:00:00.000Z',
        },
      })

      const session = await getSession('test-agent', 'settling-session')

      expect(session).not.toBeNull()
      expect(session?.id).toBe('settling-session')
      expect(session?.agentSlug).toBe('test-agent')
      expect(session?.name).toBe('Brand New')
      expect(session?.messageCount).toBe(0)
      expect(session?.createdAt.toISOString()).toBe('2026-06-18T12:00:00.000Z')
      expect(session?.lastActivityAt.toISOString()).toBe('2026-06-18T12:00:00.000Z')
    })

    it('returns null for a metadata entry with no createdAt (not a registered session)', async () => {
      // Mirrors the listSessions gate: a metadata entry without createdAt is not
      // a properly registered session, so it does not count as existing.
      await createSessionsDir('test-agent')
      await createSessionMetadata('test-agent', {
        'half-written': { name: 'No CreatedAt' },
      })

      const session = await getSession('test-agent', 'half-written')
      expect(session).toBeNull()
    })

    // The transcript is summarized in a single streaming pass rather than parsed
    // into an array, so the shapes real transcripts take — rows far wider than a
    // read chunk, tool-result user rows ahead of any prose, queued commands —
    // are what the summary has to keep getting right.
    it('summarizes a transcript whose rows are wider than a read chunk', async () => {
      const CHUNK_SIZE = 64 * 1024
      await createSessionFile('test-agent', 'wide-session', [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-02-01T10:00:00.000Z',
          message: { role: 'user', content: 'Summarize the attached log' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-02-01T10:00:05.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(CHUNK_SIZE * 3) }] },
        },
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-02-01T10:00:09.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(CHUNK_SIZE * 2) }] },
        },
      ])

      const session = await getSession('test-agent', 'wide-session')

      expect(session?.messageCount).toBe(3)
      expect(session?.createdAt.toISOString()).toBe('2026-02-01T10:00:00.000Z')
      expect(session?.lastActivityAt.toISOString()).toBe('2026-02-01T10:00:09.000Z')
      expect(session?.name).toBe('Summarize the attached log')
    })

    it('names the session from the first user row with string content, not a tool result', async () => {
      await createSessionFile('test-agent', 'tool-first', [
        // A resumed session can open on a tool_result user row; its content is an
        // array, so it must not be mistaken for the prompt.
        {
          type: 'user',
          uuid: 'u0',
          timestamp: '2026-02-02T10:00:00.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }] },
        },
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-02-02T10:00:01.000Z',
          message: { role: 'user', content: 'The actual prompt' },
        },
        // A later turn must not overwrite the name.
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-02-02T10:00:02.000Z',
          message: { role: 'user', content: 'A follow-up question' },
        },
      ])

      const session = await getSession('test-agent', 'tool-first')

      expect(session?.name).toBe('The actual prompt')
      expect(session?.messageCount).toBe(3)
      // Timestamps still span every message, including the tool_result row.
      expect(session?.createdAt.toISOString()).toBe('2026-02-02T10:00:00.000Z')
      expect(session?.lastActivityAt.toISOString()).toBe('2026-02-02T10:00:02.000Z')
    })

    it('truncates a long derived name to 50 chars with an ellipsis', async () => {
      await createSessionFile('test-agent', 'long-name', [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-02-03T10:00:00.000Z',
          message: { role: 'user', content: 'a'.repeat(80) },
        },
      ])

      const session = await getSession('test-agent', 'long-name')
      expect(session?.name).toBe(`${'a'.repeat(50)}...`)
    })

    it('counts a mid-turn queued_command attachment as a user message', async () => {
      await createSessionFile('test-agent', 'queued-session', [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-02-04T10:00:00.000Z',
          message: { role: 'user', content: 'first' },
        },
        {
          type: 'attachment',
          uuid: 'att1',
          timestamp: '2026-02-04T10:00:30.000Z',
          attachment: {
            type: 'queued_command',
            commandMode: 'prompt',
            prompt: 'steer left',
            source_uuid: 'q1',
          },
        },
        // Not user-typed — must not count.
        {
          type: 'attachment',
          uuid: 'att2',
          timestamp: '2026-02-04T10:01:00.000Z',
          attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'meta', isMeta: true },
        },
      ])

      const session = await getSession('test-agent', 'queued-session')

      expect(session?.messageCount).toBe(2)
      // The queued command is the last activity, so it moves the timestamp.
      expect(session?.lastActivityAt.toISOString()).toBe('2026-02-04T10:00:30.000Z')
    })

    it('skips a half-written trailing row rather than failing the whole session', async () => {
      const sessionsDir = await createSessionsDir('test-agent')
      await fs.promises.writeFile(
        path.join(sessionsDir, 'torn.jsonl'),
        `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-02-05T10:00:00.000Z', message: { role: 'user', content: 'hello' } })}\n{"type":"assistant","timestamp":"2026-02-05T10`
      )

      const session = await getSession('test-agent', 'torn')

      expect(session?.messageCount).toBe(1)
      expect(session?.name).toBe('hello')
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

    it('converts queued_command attachments (mid-turn messages) into user entries', async () => {
      const entries = [
        ...SAMPLE_JSONL_ENTRIES,
        {
          type: 'attachment',
          uuid: 'attachment-entry-uuid',
          parentUuid: null,
          sessionId: 'test-session',
          timestamp: '2025-01-01T00:01:00.000Z',
          attachment: {
            type: 'queued_command',
            prompt: [{ type: 'text', text: 'Queued mid-turn message' }],
            source_uuid: 'queue-source-uuid',
            commandMode: 'prompt',
          },
        },
        // Task notifications and meta queued commands are system-injected, not user-typed
        {
          type: 'attachment',
          uuid: 'notification-uuid',
          timestamp: '2025-01-01T00:02:00.000Z',
          attachment: {
            type: 'queued_command',
            prompt: '<task-notification>done</task-notification>',
            commandMode: 'task-notification',
          },
        },
        {
          type: 'attachment',
          uuid: 'meta-uuid',
          timestamp: '2025-01-01T00:03:00.000Z',
          attachment: {
            type: 'queued_command',
            prompt: 'injected context',
            source_uuid: 'meta-source-uuid',
            commandMode: 'prompt',
            isMeta: true,
          },
        },
      ]
      await createSessionFile('test-agent', 'queued-session', entries)

      const messages = await getSessionMessages('test-agent', 'queued-session')

      expect(messages.length).toBe(5)
      const queued = messages[4]
      expect(queued.type).toBe('user')
      // Uses source_uuid (the id the SDK replays this message under on resume)
      expect(queued.uuid).toBe('queue-source-uuid')
      expect(queued.timestamp).toBe('2025-01-01T00:01:00.000Z')
      expect(queued.message.content).toEqual([{ type: 'text', text: 'Queued mid-turn message' }])
    })
  })

  describe('getSessionMessagesPage', () => {
    function makeThread(n: number) {
      const entries: object[] = []
      for (let i = 0; i < n; i++) {
        entries.push({
          type: 'user',
          uuid: `u-${i}`,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2)).toISOString(),
          sessionId: 'page-session',
          parentUuid: null,
          message: { role: 'user', content: `q${i}` },
        })
        entries.push({
          type: 'assistant',
          uuid: `a-${i}`,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2 + 1)).toISOString(),
          sessionId: 'page-session',
          parentUuid: `u-${i}`,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `a${i}` }],
          },
        })
      }
      return entries
    }

    it('returns the trailing page and a cursor when more remain', async () => {
      await createSessionFile('test-agent', 'page-session', makeThread(10))

      const page = await getSessionMessagesPage('test-agent', 'page-session', { limit: 5 })
      expect(page.messages.map((m) => m.id)).toEqual(['a-7', 'u-8', 'a-8', 'u-9', 'a-9'])
      expect(page.nextCursor).toBe('a-7')
    })

    it('returns the page before a cursor', async () => {
      await createSessionFile('test-agent', 'page-session', makeThread(10))

      const page = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 5,
        cursor: 'a-7',
      })
      expect(page.messages.map((m) => m.id)).toEqual(['u-5', 'a-5', 'u-6', 'a-6', 'u-7'])
      expect(page.nextCursor).toBe('u-5')
    })

    it('returns no cursor on the oldest page', async () => {
      await createSessionFile('test-agent', 'page-session', makeThread(3))

      const page = await getSessionMessagesPage('test-agent', 'page-session', { limit: 20 })
      expect(page.messages).toHaveLength(6)
      expect(page.nextCursor).toBeNull()
    })

    it('does not include a huge prefix row in the trailing page', async () => {
      const prefix = {
        type: 'user',
        uuid: 'huge-prefix',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'page-session',
        parentUuid: null,
        message: { role: 'user', content: 'x'.repeat(80 * 1024) },
      }
      await createSessionFile('test-agent', 'page-session', [prefix, ...makeThread(20)])

      const page = await getSessionMessagesPage('test-agent', 'page-session', { limit: 4 })
      expect(page.messages.map((m) => m.id)).toEqual(['u-18', 'a-18', 'u-19', 'a-19'])
      expect(page.messages.some((m) => m.id === 'huge-prefix')).toBe(false)
      expect(page.nextCursor).toBe('u-18')
    })

    it('does not use a mid-merge assistant uuid as the page cursor', async () => {
      const meta = Array.from({ length: 27 }, (_, i) => ({
        type: 'user',
        uuid: `meta-${i}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 2, i)).toISOString(),
        sessionId: 'page-session',
        parentUuid: null,
        isMeta: true,
        message: { role: 'user', content: 'meta' },
      }))
      const tailUsers = Array.from({ length: 4 }, (_, i) => ({
        type: 'user',
        uuid: `tail-u-${i + 1}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, i + 1)).toISOString(),
        sessionId: 'page-session',
        parentUuid: null,
        message: { role: 'user', content: `tail-${i + 1}` },
      }))
      const splitAsst = [
        {
          type: 'assistant',
          uuid: 'X-0',
          timestamp: '2026-01-01T00:00:50.000Z',
          sessionId: 'page-session',
          parentUuid: null,
          message: {
            id: 'msg-X',
            role: 'assistant',
            content: [{ type: 'text', text: 'leading' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'X-1',
          timestamp: '2026-01-01T00:00:51.000Z',
          sessionId: 'page-session',
          parentUuid: null,
          message: {
            id: 'msg-X',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
          },
        },
      ]
      await createSessionFile('test-agent', 'page-session', [
        ...makeThread(20),
        ...splitAsst,
        ...tailUsers,
        ...meta,
      ])

      const first = await getSessionMessagesPage('test-agent', 'page-session', { limit: 5 })
      expect(first.messages.map((m) => m.id)).not.toContain('X-1')
      expect(first.messages[0]?.id).toBe('X-0')
      expect(first.nextCursor).toBe('X-0')
      expect(first.messages.find((m) => m.id === 'X-0')).toMatchObject({
        type: 'assistant',
        content: { text: 'leading' },
      })

      const older = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 5,
        cursor: first.nextCursor!,
      })
      expect(older.messages.length).toBeGreaterThan(0)
      expect(older.messages.map((m) => m.id)).not.toContain('X-1')
    })

    it('returns an empty terminal page when the cursor id has vanished', async () => {
      await createSessionFile('test-agent', 'page-session', makeThread(40))
      const page = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 5,
        cursor: 'vanished-id',
      })
      expect(page.messages).toEqual([])
      expect(page.nextCursor).toBeNull()
    })

    it('sequential scroll-up paging reaches the start of a long transcript', async () => {
      // 300 pairs = 600 lines, far deeper than the initial tail window (limit*4).
      await createSessionFile('test-agent', 'page-session', makeThread(300))

      const loaded = new Set<string>()
      const first = await getSessionMessagesPage('test-agent', 'page-session', { limit: 5 })
      for (const m of first.messages) loaded.add(m.id)

      let cursor = first.nextCursor
      for (let i = 0; i < 300 && cursor; i++) {
        const page = await getSessionMessagesPage('test-agent', 'page-session', {
          limit: 5,
          cursor,
        })
        for (const m of page.messages) loaded.add(m.id)
        cursor = page.nextCursor
      }

      expect(cursor).toBeNull()
      expect(loaded.size).toBe(600)
    })

    // The signal lets the /messages route stop paying for transcript reads when
    // the HTTP client has already aborted (superseded refetch). Rejection must
    // be the standard AbortError so the route can map it to 499.
    it('rejects with AbortError when the signal is already aborted', async () => {
      await createSessionFile('test-agent', 'page-session', makeThread(10))

      const controller = new AbortController()
      controller.abort()
      await expect(
        getSessionMessagesPage('test-agent', 'page-session', {
          limit: 5,
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('a never-aborted signal changes nothing', async () => {
      await createSessionFile('test-agent', 'page-session', makeThread(10))

      const controller = new AbortController()
      const page = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 5,
        signal: controller.signal,
      })
      expect(page.messages.map((m) => m.id)).toEqual(['a-7', 'u-8', 'a-8', 'u-9', 'a-9'])
      expect(page.nextCursor).toBe('a-7')
    })

    it('byte budget truncates a page short and cursor paging walks the remainder', async () => {
      await createSessionFile('test-agent', 'page-session', makeThread(30))

      // ~1KB budget against ~180-byte rows: each window holds a handful of
      // items, far fewer than the requested limit.
      const first = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 20,
        byteBudget: 1024,
      })
      expect(first.messages.length).toBeGreaterThan(0)
      expect(first.messages.length).toBeLessThan(20)
      expect(first.nextCursor).toBe(first.messages[0]!.id)

      const collected = [...first.messages.map((m) => m.id)]
      let cursor = first.nextCursor
      for (let i = 0; i < 100 && cursor; i++) {
        const page = await getSessionMessagesPage('test-agent', 'page-session', {
          limit: 20,
          cursor,
          byteBudget: 1024,
        })
        collected.unshift(...page.messages.map((m) => m.id))
        cursor = page.nextCursor
      }

      const expected: string[] = []
      for (let i = 0; i < 30; i++) expected.push(`u-${i}`, `a-${i}`)
      expect(collected).toEqual(expected)
    })

    it('serves a single item larger than the whole byte budget', async () => {
      const giant = {
        type: 'assistant',
        uuid: 'a-giant',
        timestamp: '2026-01-01T00:10:00.000Z',
        sessionId: 'page-session',
        parentUuid: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'G'.repeat(64 * 1024) }],
        },
      }
      await createSessionFile('test-agent', 'page-session', [...makeThread(5), giant])

      const page = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 5,
        byteBudget: 1024,
      })
      // The budget floor guarantees at least one servable item beyond the
      // sacrificial head — the giant trailing item must not become an empty page.
      expect(page.messages.map((m) => m.id)).toEqual(['a-giant'])
      expect(page.nextCursor).toBe('a-giant')

      const older = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 5,
        cursor: 'a-giant',
        byteBudget: 1024,
      })
      expect(older.messages.length).toBeGreaterThan(0)
    })

    it('paged walk over a mixed transcript matches the full transform', async () => {
      // Every classification the backward index scan replicates: meta rows,
      // split assistant merges with tool results, queued_command attachments,
      // task notifications, informational banners with their synthetic user
      // copy, memory recalls, compact boundaries with summaries.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 2, 0, 0, s)).toISOString()
      const entries: object[] = [
        { type: 'user', uuid: 'u-0', timestamp: ts(0), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'q0' } },
        { type: 'assistant', uuid: 'a-0', timestamp: ts(1), sessionId: 's', parentUuid: 'u-0', message: { role: 'assistant', content: [{ type: 'text', text: 'r0' }] } },
        { type: 'user', uuid: 'meta-0', timestamp: ts(2), sessionId: 's', parentUuid: null, isMeta: true, message: { role: 'user', content: 'meta' } },
        { type: 'user', uuid: 'u-1', timestamp: ts(3), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'q1' } },
        { type: 'assistant', uuid: 'A1a', timestamp: ts(4), sessionId: 's', parentUuid: 'u-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'part1 ' }] } },
        { type: 'assistant', uuid: 'A1b', timestamp: ts(5), sessionId: 's', parentUuid: 'u-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
        { type: 'user', uuid: 'r-1', timestamp: ts(6), sessionId: 's', parentUuid: 'A1b', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'user', uuid: 'task-note', timestamp: ts(7), sessionId: 's', parentUuid: null, origin: { kind: 'task-notification' }, message: { role: 'user', content: 'subagent done' } },
        { type: 'attachment', uuid: 'qc-raw', timestamp: ts(8), parentUuid: null, attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'steer', source_uuid: 'qc-u' } },
        { type: 'assistant', uuid: 'a-2', timestamp: ts(9), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'r2' }] } },
        { type: 'user', uuid: 'stop-user', timestamp: ts(10), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'Operation stopped by hook: X' } },
        { type: 'system', uuid: 'info-1', subtype: 'informational', content: 'Operation stopped by hook: X', isMeta: false, timestamp: ts(11) },
        { type: 'system', uuid: 'mr-1', subtype: 'memory_recall', content: '', isMeta: false, timestamp: ts(12), memory_paths: ['MEMORY.md'] },
        { type: 'system', uuid: 'cb-1', subtype: 'compact_boundary', content: '', isMeta: false, timestamp: ts(13), compactMetadata: { trigger: 'manual', preTokens: 5 } },
        { type: 'user', uuid: 'cs-1', timestamp: ts(14), sessionId: 's', parentUuid: null, isCompactSummary: true, message: { role: 'user', content: 'summary' } },
        { type: 'user', uuid: 'u-3', timestamp: ts(15), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'q3' } },
        { type: 'assistant', uuid: 'a-3', timestamp: ts(16), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'r3' }] } },
      ]
      await createSessionFile('test-agent', 'page-session', entries)

      // Reference: one page big enough to hold everything.
      const full = await getSessionMessagesPage('test-agent', 'page-session', { limit: 100 })
      expect(full.messages.map((m) => m.id)).toEqual([
        'u-0', 'a-0', 'u-1', 'A1a', 'qc-u', 'a-2', 'mr-1', 'cb-1', 'info-1', 'u-3', 'a-3',
      ])

      // Small pages + small budget: the same items must come back, in order,
      // with the split assistant still merged and its tool result attached.
      const first = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 3,
        byteBudget: 600,
      })
      const collected = [...first.messages]
      let cursor = first.nextCursor
      for (let i = 0; i < 50 && cursor; i++) {
        const page = await getSessionMessagesPage('test-agent', 'page-session', {
          limit: 3,
          cursor,
          byteBudget: 600,
        })
        collected.unshift(...page.messages)
        cursor = page.nextCursor
      }

      expect(collected.map((m) => m.id)).toEqual(full.messages.map((m) => m.id))
      const merged = collected.find((m) => m.id === 'A1a')
      expect(merged).toMatchObject({ type: 'assistant', content: { text: 'part1 ' } })
      expect(merged!.type === 'assistant' && merged!.toolCalls[0]).toMatchObject({
        id: 't1',
        result: 'ok',
      })
      const queued = collected.find((m) => m.id === 'qc-u')
      expect(queued).toMatchObject({ type: 'user', queued: true, content: { text: 'steer' } })
    })

    it('terminates and returns each item once when history is replayed verbatim', async () => {
      // Session resume can re-append prior history to the transcript with the
      // SAME uuids. The transform canonicalizes duplicates to their oldest
      // occurrence; cursor resolution must do the same, or paging anchors on
      // the newest copy and cycles over the same pages forever.
      const six = makeThread(3)
      await createSessionFile('test-agent', 'page-session', [...six, ...six])

      const first = await getSessionMessagesPage('test-agent', 'page-session', { limit: 3 })
      const collected = [...first.messages.map((m) => m.id)]
      let cursor = first.nextCursor
      for (let i = 0; i < 10 && cursor; i++) {
        const page = await getSessionMessagesPage('test-agent', 'page-session', {
          limit: 3,
          cursor,
        })
        collected.unshift(...page.messages.map((m) => m.id))
        cursor = page.nextCursor
      }

      expect(cursor).toBeNull()
      expect(collected).toEqual(['u-0', 'a-0', 'u-1', 'a-1', 'u-2', 'a-2'])
    })

    it('returns every trailing system item across pages despite display reordering', async () => {
      // The transform orders adjacent system items by type (recalls, then
      // boundaries, then informationals) regardless of file order. A window
      // boundary landing inside such a run must not make pagination skip the
      // reordered items.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 6, 0, 0, s)).toISOString()
      await createSessionFile('test-agent', 'page-session', [
        { type: 'user', uuid: 'u-0', timestamp: ts(0), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'q0' } },
        { type: 'system', uuid: 'info1', subtype: 'informational', content: 'note one', isMeta: false, timestamp: ts(1) },
        { type: 'system', uuid: 'mr', subtype: 'memory_recall', content: '', isMeta: false, timestamp: ts(2), memory_paths: ['M.md'] },
        { type: 'system', uuid: 'cb', subtype: 'compact_boundary', content: '', isMeta: false, timestamp: ts(3), compactMetadata: { trigger: 'manual', preTokens: 1 } },
        { type: 'system', uuid: 'info2', subtype: 'informational', content: 'note two', isMeta: false, timestamp: ts(4) },
      ])

      const full = await getSessionMessagesPage('test-agent', 'page-session', { limit: 100 })
      expect(full.messages.map((m) => m.id)).toEqual(['u-0', 'mr', 'cb', 'info1', 'info2'])

      const first = await getSessionMessagesPage('test-agent', 'page-session', { limit: 1 })
      const collected = [...first.messages.map((m) => m.id)]
      let cursor = first.nextCursor
      for (let i = 0; i < 10 && cursor; i++) {
        const page = await getSessionMessagesPage('test-agent', 'page-session', {
          limit: 1,
          cursor,
        })
        collected.unshift(...page.messages.map((m) => m.id))
        cursor = page.nextCursor
      }

      expect(cursor).toBeNull()
      expect(collected).toEqual(['u-0', 'mr', 'cb', 'info1', 'info2'])
    })

    it('attaches an oversized tool result that starts inside the grace region', async () => {
      // The window past the cursor must end on a LINE boundary: a fixed byte
      // end would cut this 600KB result row mid-line and drop it as
      // malformed, leaving the historical call permanently unresolved.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 7, 0, 0, s)).toISOString()
      const big = 'X'.repeat(600 * 1024)
      await createSessionFile('test-agent', 'page-session', [
        ...makeThread(2),
        { type: 'user', uuid: 'u-ask', timestamp: ts(10), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'run it' } },
        { type: 'assistant', uuid: 'X-use', timestamp: ts(11), sessionId: 's', parentUuid: 'u-ask', message: { id: 'msg-X', role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: {} }] } },
        { type: 'attachment', uuid: 'qc-raw', timestamp: ts(12), parentUuid: null, attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'steer', source_uuid: 'qc-2' } },
        { type: 'user', uuid: 'r-9', timestamp: ts(13), sessionId: 's', parentUuid: 'X-use', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: big }] } },
        { type: 'assistant', uuid: 'a-done', timestamp: ts(14), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ])

      const page = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 2,
        cursor: 'qc-2',
      })
      expect(page.messages.map((m) => m.id)).toEqual(['u-ask', 'X-use'])
      const use = page.messages[1]
      expect(use!.type === 'assistant' && use!.toolCalls[0]?.result?.length).toBe(big.length)
    })

    it('hard cap bounds a huge non-display gap and still serves the trailing item', async () => {
      // Tool-result-only rows are not display items, so the two-item budget
      // floor alone would scan through an arbitrarily large run of them. The
      // hard cap stops the scan once its one-servable-item floor is met; the
      // trailing item (complete, single-entry) must be served rather than
      // sacrificed, and cursor paging must cross the gap to older history.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 8, 0, 0, s)).toISOString()
      const rows: object[] = [
        ...makeThread(2),
        { type: 'assistant', uuid: 'A-use', timestamp: ts(10), sessionId: 's', parentUuid: null, message: { id: 'msg-A', role: 'assistant', content: [{ type: 'tool_use', id: 'tg', name: 'Bash', input: {} }] } },
      ]
      for (let i = 0; i < 20; i++) {
        rows.push({ type: 'user', uuid: `rg-${i}`, timestamp: ts(11 + i), sessionId: 's', parentUuid: 'A-use', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tg', content: 'y'.repeat(1024) }] } })
      }
      rows.push({ type: 'assistant', uuid: 'a-done', timestamp: ts(40), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
      await createSessionFile('test-agent', 'page-session', rows)

      // budget 1024 → hard cap 2048, far below the ~20KB result gap.
      const first = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 5,
        byteBudget: 1024,
      })
      expect(first.messages.map((m) => m.id)).toEqual(['a-done'])

      let cursor = first.nextCursor
      let hops = 0
      for (let i = 0; i < 5 && cursor; i++) {
        const page = await getSessionMessagesPage('test-agent', 'page-session', {
          limit: 5,
          cursor,
          byteBudget: 1024,
        })
        hops++
        cursor = page.nextCursor
      }
      expect(cursor).toBeNull()
      expect(hops).toBeLessThanOrEqual(2)
    })

    it('serves the visible history behind a capped trailing tool-result run', async () => {
      // A turn that just wrote its tool results leaves only non-display rows
      // at EOF. The hard cap must not settle before at least one servable
      // item is in the window — an empty terminal page here would blank the
      // whole session in the client.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 9, 0, 0, s)).toISOString()
      const rows: object[] = [
        { type: 'user', uuid: 'u-0', timestamp: ts(0), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'q0' } },
        { type: 'assistant', uuid: 'A-use', timestamp: ts(1), sessionId: 's', parentUuid: null, message: { id: 'msg-A', role: 'assistant', content: [{ type: 'tool_use', id: 'tg', name: 'Bash', input: {} }] } },
      ]
      for (let i = 0; i < 10; i++) {
        rows.push({ type: 'user', uuid: `rg-${i}`, timestamp: ts(2 + i), sessionId: 's', parentUuid: 'A-use', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tg', content: 'y'.repeat(1024) }] } })
      }
      await createSessionFile('test-agent', 'page-session', rows)

      // budget 512 -> hard cap 1024, far below the trailing 10KB result run.
      const page = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 5,
        byteBudget: 512,
      })
      expect(page.messages.map((m) => m.id)).toEqual(['u-0', 'A-use'])
      const use = page.messages[1]
      expect(use!.type === 'assistant' && use!.toolCalls[0]?.result).toBeDefined()
    })

    it('never cuts a merge group split by an interleaved queued message', async () => {
      // old -> A0(id=M) -> queued Q -> A1(id=M) -> N: the group's older entry
      // lies below the queued row. A window boundary between Q and A0 would
      // serve a partial item under A1's non-canonical id, which then vanishes
      // from the next window and terminates pagination.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 10, 0, 0, s)).toISOString()
      await createSessionFile('test-agent', 'page-session', [
        { type: 'user', uuid: 'old', timestamp: ts(0), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'earlier' } },
        { type: 'assistant', uuid: 'A0', timestamp: ts(1), sessionId: 's', parentUuid: null, message: { id: 'M', role: 'assistant', content: [{ type: 'text', text: 'part one ' }] } },
        { type: 'attachment', uuid: 'q-raw', timestamp: ts(2), parentUuid: null, attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'steer', source_uuid: 'Q' } },
        { type: 'assistant', uuid: 'A1', timestamp: ts(3), sessionId: 's', parentUuid: null, message: { id: 'M', role: 'assistant', content: [{ type: 'text', text: 'part two' }] } },
        { type: 'user', uuid: 'N', timestamp: ts(4), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'newest' } },
      ])

      const first = await getSessionMessagesPage('test-agent', 'page-session', { limit: 2 })
      expect(first.messages.map((m) => m.id)).toEqual(['Q', 'N'])

      const older = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 2,
        cursor: first.nextCursor!,
      })
      expect(older.messages.map((m) => m.id)).toEqual(['old', 'A0'])
      expect(older.messages[1]).toMatchObject({ content: { text: 'part one part two' } })
      expect(older.nextCursor).toBeNull()
    })

    it('walks system runs split by meta rows without losing items', async () => {
      // A meta row between system entries is filtered out before the
      // transform runs, so the entries on either side are adjacent in
      // transform semantics and reorder as one run — the scan boundary must
      // treat them the same way.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 11, 0, 0, s)).toISOString()
      const sys = (uuid: string, subtype: string, s: number, extra: object = {}) => ({
        type: 'system', uuid, subtype, content: '', isMeta: false, timestamp: ts(s), ...extra,
      })
      await createSessionFile('test-agent', 'page-session', [
        { type: 'user', uuid: 'u-0', timestamp: ts(0), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'q0' } },
        sys('info1', 'informational', 1, { content: 'note one' }),
        { type: 'user', uuid: 'meta-x', timestamp: ts(2), sessionId: 's', parentUuid: null, isMeta: true, message: { role: 'user', content: 'meta' } },
        sys('mr', 'memory_recall', 3, { memory_paths: ['M.md'] }),
        sys('cb', 'compact_boundary', 4, { compactMetadata: { trigger: 'manual', preTokens: 1 } }),
        sys('info2', 'informational', 5, { content: 'note two' }),
      ])

      const full = await getSessionMessagesPage('test-agent', 'page-session', { limit: 100 })
      const first = await getSessionMessagesPage('test-agent', 'page-session', { limit: 1 })
      const collected = [...first.messages.map((m) => m.id)]
      let cursor = first.nextCursor
      for (let i = 0; i < 10 && cursor; i++) {
        const page = await getSessionMessagesPage('test-agent', 'page-session', {
          limit: 1,
          cursor,
        })
        collected.unshift(...page.messages.map((m) => m.id))
        cursor = page.nextCursor
      }

      expect(cursor).toBeNull()
      expect(collected).toEqual(full.messages.map((m) => m.id))
      expect(collected).toContain('info1')
    })

    it('pages across a capped gap when the cursor sits in a reordered system run', async () => {
      // The system run after the gap reorders (recalls before boundaries
      // before informationals), so the raw rows below a system cursor can
      // transform to display-AFTER it. If they satisfied the item count, the
      // page would come out empty and terminate paging while older visible
      // history exists behind the gap.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 12, 0, 0, s)).toISOString()
      const rows: object[] = [
        { type: 'user', uuid: 'old-u', timestamp: ts(0), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'older q' } },
        { type: 'assistant', uuid: 'old-a', timestamp: ts(1), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'older r' }] } },
        { type: 'assistant', uuid: 'A-use', timestamp: ts(2), sessionId: 's', parentUuid: null, message: { id: 'msg-A', role: 'assistant', content: [{ type: 'tool_use', id: 'tg', name: 'Bash', input: {} }] } },
      ]
      for (let i = 0; i < 10; i++) {
        rows.push({ type: 'user', uuid: `rg-${i}`, timestamp: ts(3 + i), sessionId: 's', parentUuid: 'A-use', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tg', content: 'y'.repeat(1024) }] } })
      }
      rows.push(
        { type: 'system', uuid: 'cb', subtype: 'compact_boundary', content: '', isMeta: false, timestamp: ts(20), compactMetadata: { trigger: 'auto', preTokens: 1 } },
        { type: 'system', uuid: 'mr', subtype: 'memory_recall', content: '', isMeta: false, timestamp: ts(21), memory_paths: ['M.md'] },
        { type: 'system', uuid: 'info', subtype: 'informational', content: 'note', isMeta: false, timestamp: ts(22) },
        { type: 'user', uuid: 'new-u', timestamp: ts(23), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'new q' } },
        { type: 'assistant', uuid: 'new-a', timestamp: ts(24), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'new r' }] } },
      )
      await createSessionFile('test-agent', 'page-session', rows)

      const full = await getSessionMessagesPage('test-agent', 'page-session', { limit: 100 })
      const first = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 5,
        byteBudget: 512,
      })
      expect(first.messages.map((m) => m.id)).toEqual(['mr', 'cb', 'info', 'new-u', 'new-a'])
      const collected = [...first.messages.map((m) => m.id)]
      let cursor = first.nextCursor
      for (let i = 0; i < 10 && cursor; i++) {
        const page = await getSessionMessagesPage('test-agent', 'page-session', {
          limit: 5,
          cursor,
          byteBudget: 512,
        })
        collected.unshift(...page.messages.map((m) => m.id))
        cursor = page.nextCursor
      }
      expect(cursor).toBeNull()
      expect(collected).toEqual(full.messages.map((m) => m.id))
    })

    it('keeps a heterogeneous system run whole under a small hard cap', async () => {
      // Every row is individually below the cap, but the run collectively
      // exceeds it: run completion is cap-exempt, so no window boundary may
      // land inside the reorderable group.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 13, 0, 0, s)).toISOString()
      const pad = 'p'.repeat(300)
      await createSessionFile('test-agent', 'page-session', [
        { type: 'user', uuid: 'older-u', timestamp: ts(0), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'older' } },
        { type: 'assistant', uuid: 'older-a', timestamp: ts(1), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'older r' }] } },
        { type: 'system', uuid: 'recall', subtype: 'memory_recall', content: pad, isMeta: false, timestamp: ts(2), memory_paths: ['M.md'] },
        { type: 'system', uuid: 'boundary', subtype: 'compact_boundary', content: pad, isMeta: false, timestamp: ts(3), compactMetadata: { trigger: 'auto', preTokens: 1 } },
        { type: 'system', uuid: 'info1', subtype: 'informational', content: `note one ${pad}`, isMeta: false, timestamp: ts(4) },
        { type: 'system', uuid: 'info2', subtype: 'informational', content: `note two ${pad}`, isMeta: false, timestamp: ts(5) },
        { type: 'user', uuid: 'newer-u', timestamp: ts(6), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'newer' } },
        { type: 'assistant', uuid: 'newer-a', timestamp: ts(7), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'newer r' }] } },
      ])

      const full = await getSessionMessagesPage('test-agent', 'page-session', { limit: 100 })
      for (const [limit, byteBudget] of [[2, 400], [3, 700], [1, 400]] as const) {
        const first = await getSessionMessagesPage('test-agent', 'page-session', { limit, byteBudget })
        const collected = [...first.messages.map((m) => m.id)]
        let cursor = first.nextCursor
        for (let i = 0; i < 15 && cursor; i++) {
          const page = await getSessionMessagesPage('test-agent', 'page-session', {
            limit,
            cursor,
            byteBudget,
          })
          collected.unshift(...page.messages.map((m) => m.id))
          cursor = page.nextCursor
        }
        expect(cursor).toBeNull()
        expect(collected).toEqual(full.messages.map((m) => m.id))
      }
    })

    it('collapses repeated compact boundaries like the transform does', async () => {
      // Boundary/summary pairs with no message between them all share one
      // anchor; the transform keeps only the newest. Counting each would
      // satisfy the page target with items that never display, and the
      // system-cursor page below the surviving boundary must reach the real
      // older messages.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 14, 0, 0, s)).toISOString()
      const rows: object[] = [
        { type: 'user', uuid: 'U', timestamp: ts(0), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'q' } },
        { type: 'assistant', uuid: 'A', timestamp: ts(1), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } },
      ]
      for (let i = 1; i <= 4; i++) {
        rows.push({ type: 'system', uuid: `c${i}`, subtype: 'compact_boundary', content: '', isMeta: false, timestamp: ts(1 + i), compactMetadata: { trigger: 'auto', preTokens: i } })
        rows.push({ type: 'user', uuid: `s${i}`, timestamp: ts(6 + i), sessionId: 's', parentUuid: null, isCompactSummary: true, message: { role: 'user', content: `summary ${i}` } })
      }
      rows.push({ type: 'user', uuid: 'N', timestamp: ts(20), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'after' } })
      await createSessionFile('test-agent', 'page-session', rows)

      const full = await getSessionMessagesPage('test-agent', 'page-session', { limit: 100 })
      expect(full.messages.map((m) => m.id)).toEqual(['U', 'A', 'c4', 'N'])

      const first = await getSessionMessagesPage('test-agent', 'page-session', { limit: 2 })
      expect(first.messages.map((m) => m.id)).toEqual(['c4', 'N'])
      const older = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 2,
        cursor: first.nextCursor!,
      })
      expect(older.messages.map((m) => m.id)).toEqual(['U', 'A'])
      expect(older.nextCursor).toBeNull()
    })

    it('replayed duplicate anchors do not reopen a collapsed boundary span', async () => {
      // Byte-identical replayed rows share their original's uuid, and the
      // transform keys boundary collapse BY uuid — so boundaries separated
      // only by duplicates of one anchor all collapse to the newest. If each
      // duplicate reset the span, the collapsed boundaries would satisfy the
      // page target and the cursor page below the survivor would come out
      // empty, hiding the real older messages.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 15, 0, 0, s)).toISOString()
      const boundary = (uuid: string, s: number) => ({
        type: 'system', uuid, subtype: 'compact_boundary', content: '', isMeta: false,
        timestamp: ts(s), compactMetadata: { trigger: 'auto', preTokens: 1 },
      })
      const X = { type: 'user', uuid: 'X', timestamp: ts(10), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'anchor msg' } }
      await createSessionFile('test-agent', 'page-session', [
        { type: 'user', uuid: 'U', timestamp: ts(0), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'q' } },
        { type: 'assistant', uuid: 'A', timestamp: ts(1), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } },
        boundary('c1', 2), X,
        boundary('c2', 3), X,
        boundary('c3', 4), X,
        boundary('c4', 5), X,
      ])

      const full = await getSessionMessagesPage('test-agent', 'page-session', { limit: 100 })
      expect(full.messages.map((m) => m.id)).toEqual(['U', 'A', 'c4', 'X'])

      const first = await getSessionMessagesPage('test-agent', 'page-session', { limit: 2 })
      const collected = [...first.messages.map((m) => m.id)]
      let cursor = first.nextCursor
      for (let i = 0; i < 10 && cursor; i++) {
        const page = await getSessionMessagesPage('test-agent', 'page-session', {
          limit: 2,
          cursor,
        })
        collected.unshift(...page.messages.map((m) => m.id))
        cursor = page.nextCursor
      }
      expect(cursor).toBeNull()
      expect(collected).toEqual(['U', 'A', 'c4', 'X'])
    })

    it('attaches a tool result recorded past the cursor line', async () => {
      // A queued user message lands between a tool_use and its result, and
      // becomes the page cursor: the result then sits ABOVE the cursor line,
      // inside the window's forward grace region.
      const ts = (s: number) => new Date(Date.UTC(2026, 0, 3, 0, 0, s)).toISOString()
      const entries: object[] = [
        ...makeThread(2),
        { type: 'user', uuid: 'u-ask', timestamp: ts(10), sessionId: 's', parentUuid: null, message: { role: 'user', content: 'run it' } },
        { type: 'assistant', uuid: 'X-use', timestamp: ts(11), sessionId: 's', parentUuid: 'u-ask', message: { id: 'msg-X', role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'sleep' } }] } },
        { type: 'attachment', uuid: 'qc2-raw', timestamp: ts(12), parentUuid: null, attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'steer2', source_uuid: 'qc-2' } },
        { type: 'user', uuid: 'r-9', timestamp: ts(13), sessionId: 's', parentUuid: 'X-use', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'late-ok' }] } },
        { type: 'assistant', uuid: 'a-done', timestamp: ts(14), sessionId: 's', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ]
      await createSessionFile('test-agent', 'page-session', entries)

      const page = await getSessionMessagesPage('test-agent', 'page-session', {
        limit: 2,
        cursor: 'qc-2',
      })
      expect(page.messages.map((m) => m.id)).toEqual(['u-ask', 'X-use'])
      const use = page.messages[1]
      expect(use!.type === 'assistant' && use!.toolCalls[0]).toMatchObject({
        id: 't9',
        result: 'late-ok',
      })
    })
  })

  describe('getSessionMessagesDelta', () => {
    function makeThread(n: number, sessionId = 'delta-session') {
      const entries: object[] = []
      for (let i = 0; i < n; i++) {
        entries.push({
          type: 'user',
          uuid: `u-${i}`,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2)).toISOString(),
          sessionId,
          parentUuid: null,
          message: { role: 'user', content: `q${i}` },
        })
        entries.push({
          type: 'assistant',
          uuid: `a-${i}`,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2 + 1)).toISOString(),
          sessionId,
          parentUuid: `u-${i}`,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `a${i}` }],
          },
        })
      }
      return entries
    }

    it('returns upserts at-or-after the anchor plus items appended since', async () => {
      await createSessionFile('test-agent', 'delta-session', makeThread(10))

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'u-8',
      })
      expect(delta.resync).toBeUndefined()
      expect(delta.messages.map((m) => m.id)).toEqual(['u-8', 'a-8', 'u-9', 'a-9'])
      // The trailing assistant may still merge streamed blocks, so the settled
      // anchor is the user message before it.
      expect(delta.anchor).toBe('u-9')
    })

    it('a tool_result landing after the anchor updates the already-served assistant item', async () => {
      // Assistant X calls a tool; a queued (mid-turn) user message follows, so a
      // client could legitimately anchor past X while X's call is still open.
      const base = [
        ...makeThread(3),
        {
          type: 'assistant',
          uuid: 'X',
          timestamp: '2026-01-01T00:01:00.000Z',
          sessionId: 'delta-session',
          parentUuid: 'a-2',
          message: {
            id: 'msg-X',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
          },
        },
        {
          type: 'attachment',
          uuid: 'q-attachment',
          timestamp: '2026-01-01T00:01:05.000Z',
          sessionId: 'delta-session',
          attachment: {
            type: 'queued_command',
            prompt: [{ type: 'text', text: 'steering note' }],
            source_uuid: 'q-1',
            commandMode: 'prompt',
          },
        },
      ]
      await createSessionFile('test-agent', 'delta-session', base)

      const before = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'q-1',
      })
      // Defensive widening: the open tool call before the anchor is re-emitted.
      expect(before.messages.map((m) => m.id)).toEqual(['X', 'q-1'])
      const openCall = before.messages.find((m) => m.id === 'X')
      expect(openCall).toMatchObject({ toolCalls: [{ id: 't1', result: undefined }] })

      await createSessionFile('test-agent', 'delta-session', [
        ...base,
        {
          type: 'user',
          uuid: 'tr-1',
          timestamp: '2026-01-01T00:01:10.000Z',
          sessionId: 'delta-session',
          parentUuid: 'X',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2' }],
          },
        },
      ])

      const after = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'q-1',
      })
      expect(after.messages.map((m) => m.id)).toEqual(['X', 'q-1'])
      const resolvedCall = after.messages.find((m) => m.id === 'X')
      expect(resolvedCall).toMatchObject({ toolCalls: [{ id: 't1', result: 'file1\nfile2' }] })
    })

    it('widens the window to the trailing assistant when the anchor sits after it', async () => {
      // e.g. the client anchored on a trailing informational banner while the
      // assistant message before it can still merge streamed blocks.
      await createSessionFile('test-agent', 'delta-session', [
        ...makeThread(3),
        {
          type: 'system',
          subtype: 'informational',
          uuid: 'info-1',
          timestamp: '2026-01-01T00:02:00.000Z',
          sessionId: 'delta-session',
          content: 'a hook blocked something',
        },
      ])

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'info-1',
      })
      expect(delta.messages.map((m) => m.id)).toEqual(['a-2', 'info-1'])
      expect(delta.anchor).toBe('u-2')
    })

    it('grows the tail window until a deep anchor resolves', async () => {
      // 200 pairs = 400 raw lines, past the initial 128-line window.
      await createSessionFile('test-agent', 'delta-session', makeThread(200))

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'u-30',
      })
      expect(delta.resync).toBeUndefined()
      expect(delta.messages[0]?.id).toBe('u-30')
      expect(delta.messages.at(-1)?.id).toBe('a-199')
      expect(delta.messages).toHaveLength(340)
    })

    it('answers resync when the anchor id is not in the transcript', async () => {
      await createSessionFile('test-agent', 'delta-session', makeThread(10))

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'vanished-id',
      })
      expect(delta).toEqual({ messages: [], anchor: null, resync: true })
    })

    it('answers resync when the transcript file is gone', async () => {
      await createSessionsDir('test-agent')

      const delta = await getSessionMessagesDelta('test-agent', 'nonexistent', {
        after: 'u-1',
      })
      expect(delta).toEqual({ messages: [], anchor: null, resync: true })
    })

    it('answers resync instead of scanning past the bounded tail', async () => {
      // 5100 pairs = 10200 raw lines; u-0 sits beyond the 10k-line delta cap.
      await createSessionFile('test-agent', 'delta-session', makeThread(5100))

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'u-0',
      })
      expect(delta).toEqual({ messages: [], anchor: null, resync: true })
    })

    it('rejects with AbortError when the signal is already aborted', async () => {
      await createSessionFile('test-agent', 'delta-session', makeThread(10))

      const controller = new AbortController()
      controller.abort()
      await expect(
        getSessionMessagesDelta('test-agent', 'delta-session', {
          after: 'u-8',
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('re-serves the still-streaming assistant when the anchor is a queued message after it', async () => {
      // Steering input lands mid-turn; more blocks for the assistant before it
      // can still arrive. Anchoring on the queued message must not freeze the
      // assistant's partial text on the client.
      await createSessionFile('test-agent', 'delta-session', [
        ...makeThread(2),
        {
          type: 'assistant',
          uuid: 'S-0',
          timestamp: '2026-01-01T00:01:00.000Z',
          sessionId: 'delta-session',
          parentUuid: 'a-1',
          message: {
            id: 'msg-S',
            role: 'assistant',
            content: [{ type: 'text', text: 'streaming ' }],
          },
        },
        {
          type: 'attachment',
          uuid: 'q-attachment',
          timestamp: '2026-01-01T00:01:05.000Z',
          sessionId: 'delta-session',
          attachment: {
            type: 'queued_command',
            prompt: [{ type: 'text', text: 'steering note' }],
            source_uuid: 'q-1',
            commandMode: 'prompt',
          },
        },
        {
          type: 'assistant',
          uuid: 'S-1',
          timestamp: '2026-01-01T00:01:10.000Z',
          sessionId: 'delta-session',
          parentUuid: 'q-attachment',
          message: {
            id: 'msg-S',
            role: 'assistant',
            content: [{ type: 'text', text: 'continued' }],
          },
        },
      ])

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'q-1',
      })
      expect(delta.messages.map((m) => m.id)).toEqual(['S-0', 'q-1'])
      expect(delta.messages[0]).toMatchObject({ content: { text: 'streaming continued' } })
    })

    it('grows the window until a late tool_result finds its parent assistant item', async () => {
      // The parent call sits well past the initial 128-line window; its result
      // lands after the anchor. Without growth the parent's upsert would be
      // silently skipped and the client's copy stay unresolved forever.
      const parent = {
        type: 'assistant',
        uuid: 'P',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'delta-session',
        parentUuid: null,
        message: {
          id: 'msg-P',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'deep-t1', name: 'AskUserQuestion', input: {} }],
        },
      }
      const filler = makeThread(100).map((e, i) => ({
        ...e,
        uuid: `f-${i}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 1, 0, i)).toISOString(),
      }))
      const anchorMsg = {
        type: 'user',
        uuid: 'anchor-u',
        timestamp: '2026-01-01T02:00:00.000Z',
        sessionId: 'delta-session',
        parentUuid: null,
        message: { role: 'user', content: 'latest question' },
      }
      const lateResult = {
        type: 'user',
        uuid: 'tr-deep',
        timestamp: '2026-01-01T02:00:10.000Z',
        sessionId: 'delta-session',
        parentUuid: 'P',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'deep-t1', content: 'answered' }],
        },
      }
      await createSessionFile('test-agent', 'delta-session', [
        parent,
        ...filler,
        anchorMsg,
        lateResult,
      ])

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'anchor-u',
      })
      expect(delta.resync).toBeUndefined()
      expect(delta.messages[0]?.id).toBe('P')
      expect(delta.messages[0]).toMatchObject({
        toolCalls: [{ id: 'deep-t1', result: 'answered' }],
      })
    })

    it('a trailing orphan tool_result on a transcript beyond the tail cap does not resync-loop', async () => {
      // The parent (if any) lies deeper than the bounded tail can reach; a
      // resync here would repeat on EVERY poll — full fetch, new delta, same
      // orphan — recreating the refetch cascade. Serve the delta without the
      // unreachable parent instead.
      await createSessionFile('test-agent', 'delta-session', [
        ...makeThread(5100),
        {
          type: 'user',
          uuid: 'tr-beyond-cap',
          timestamp: '2026-01-01T06:00:00.000Z',
          sessionId: 'delta-session',
          parentUuid: null,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'unreachable-t1', content: 'late' }],
          },
        },
      ])

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'u-5099',
      })
      expect(delta.resync).toBeUndefined()
      expect(delta.messages[0]?.id).toBe('u-5099')
    })

    it('an orphaned tool_result (parent rewritten away) does not force resync', async () => {
      await createSessionFile('test-agent', 'delta-session', [
        ...makeThread(3),
        {
          type: 'user',
          uuid: 'tr-orphan',
          timestamp: '2026-01-01T00:05:00.000Z',
          sessionId: 'delta-session',
          parentUuid: null,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'gone-t1', content: 'orphan' }],
          },
        },
      ])

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'u-2',
      })
      expect(delta.resync).toBeUndefined()
      expect(delta.messages[0]?.id).toBe('u-2')
    })

    it('merges a block-split assistant message into one upsert item', async () => {
      await createSessionFile('test-agent', 'delta-session', [
        ...makeThread(2),
        {
          type: 'assistant',
          uuid: 'X-0',
          timestamp: '2026-01-01T00:01:00.000Z',
          sessionId: 'delta-session',
          parentUuid: 'a-1',
          message: {
            id: 'msg-X',
            role: 'assistant',
            content: [{ type: 'text', text: 'leading ' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'X-1',
          timestamp: '2026-01-01T00:01:01.000Z',
          sessionId: 'delta-session',
          parentUuid: 'X-0',
          message: {
            id: 'msg-X',
            role: 'assistant',
            content: [{ type: 'text', text: 'trailing' }],
          },
        },
      ])

      const delta = await getSessionMessagesDelta('test-agent', 'delta-session', {
        after: 'u-1',
      })
      expect(delta.messages.map((m) => m.id)).toEqual(['u-1', 'a-1', 'X-0'])
      expect(delta.messages.at(-1)).toMatchObject({ content: { text: 'leading trailing' } })
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

    it('deletes a dangling metadata-only session (no JSONL)', async () => {
      // Metadata entry whose transcript was already removed (e.g. by the CLI's
      // retention cleanup). Deletion must still clear the metadata.
      await createSessionsDir('test-agent')
      await createSessionMetadata('test-agent', {
        'dangling-session': { name: 'Dangling', createdAt: '2026-01-24T10:00:00.000Z' },
      })

      const result = await deleteSession('test-agent', 'dangling-session')

      expect(result).toBe(true)
      const metadata = await getSessionMetadata('test-agent', 'dangling-session')
      expect(metadata).toBeNull()
    })
  })

  describe('deleteSessionsBatch', () => {
    it('returns empty array when given no session IDs', async () => {
      const result = await deleteSessionsBatch('test-agent', [])
      expect(result).toEqual([])
    })

    it('deletes multiple JSONL files and returns their IDs', async () => {
      await createSessionFile('test-agent', 'session-1', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'session-2', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'session-3', SAMPLE_JSONL_ENTRIES)

      const result = await deleteSessionsBatch('test-agent', [
        'session-1',
        'session-2',
      ])

      expect(result).toEqual(['session-1', 'session-2'])
      expect(await sessionExists('test-agent', 'session-1')).toBe(false)
      expect(await sessionExists('test-agent', 'session-2')).toBe(false)
      expect(await sessionExists('test-agent', 'session-3')).toBe(true)
    })

    it('removes metadata entries for deleted sessions', async () => {
      await createSessionFile('test-agent', 'session-1', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'session-2', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'session-1': { name: 'First', createdAt: '2026-01-01T00:00:00Z' },
        'session-2': { name: 'Second', createdAt: '2026-01-02T00:00:00Z' },
        'session-3': { name: 'Third', createdAt: '2026-01-03T00:00:00Z' },
      })

      await deleteSessionsBatch('test-agent', ['session-1', 'session-2'])

      const metadata = await readSessionMetadata('test-agent')
      expect(metadata['session-1']).toBeUndefined()
      expect(metadata['session-2']).toBeUndefined()
      expect(metadata['session-3']).toBeDefined()
      expect(metadata['session-3'].name).toBe('Third')
    })

    it('handles missing JSONL files gracefully (ENOENT)', async () => {
      await createSessionsDir('test-agent')
      await createSessionMetadata('test-agent', {
        'missing-session': {
          name: 'Gone',
          createdAt: '2026-01-01T00:00:00Z',
        },
      })

      const result = await deleteSessionsBatch('test-agent', ['missing-session'])

      expect(result).toEqual(['missing-session'])
      const metadata = await readSessionMetadata('test-agent')
      expect(metadata['missing-session']).toBeUndefined()
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

  describe('sessionIsKnown', () => {
    // Existence guards use this instead of getSession, so it has to agree with
    // getSession on every case — otherwise a route 404s a session the rest of
    // the app considers real (or the reverse).
    it('agrees with getSession on a written transcript', async () => {
      await createSessionFile('test-agent', 'test-session', SAMPLE_JSONL_ENTRIES)

      expect(await sessionIsKnown('test-agent', 'test-session')).toBe(true)
      expect(await getSession('test-agent', 'test-session')).not.toBeNull()
    })

    it('agrees with getSession on a registered session with no transcript yet', async () => {
      await createSessionsDir('test-agent')
      await createSessionMetadata('test-agent', {
        'settling-session': { name: 'Brand New', createdAt: '2026-06-18T12:00:00.000Z' },
      })

      expect(await sessionIsKnown('test-agent', 'settling-session')).toBe(true)
      expect(await getSession('test-agent', 'settling-session')).not.toBeNull()
    })

    it('agrees with getSession on a metadata entry with no createdAt', async () => {
      await createSessionsDir('test-agent')
      await createSessionMetadata('test-agent', { 'half-written': { name: 'No CreatedAt' } })

      expect(await sessionIsKnown('test-agent', 'half-written')).toBe(false)
      expect(await getSession('test-agent', 'half-written')).toBeNull()
    })

    it('agrees with getSession on an unknown session', async () => {
      await createSessionsDir('test-agent')

      expect(await sessionIsKnown('test-agent', 'nonexistent')).toBe(false)
      expect(await getSession('test-agent', 'nonexistent')).toBeNull()
    })

    it('never reads the transcript', async () => {
      // The whole point: a 404 guard must not pay for a 100MB transcript pass.
      await createSessionFile('test-agent', 'test-session', SAMPLE_JSONL_ENTRIES)
      const openSpy = vi.spyOn(fs.promises, 'open')

      try {
        expect(await sessionIsKnown('test-agent', 'test-session')).toBe(true)
        expect(
          openSpy.mock.calls.some(([file]) => String(file).endsWith('test-session.jsonl')),
        ).toBe(false)
      } finally {
        openSpy.mockRestore()
      }
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

    it('removes a queued message by its source_uuid (underlying attachment entry)', async () => {
      const entries = [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:00.000Z',
          message: { role: 'user', content: 'Start' },
        },
        // Mid-turn message: persisted as an attachment, surfaced in the UI
        // with id = attachment.source_uuid (not the entry's top-level uuid)
        {
          type: 'attachment',
          uuid: 'attachment-entry-uuid',
          parentUuid: 'user-1',
          sessionId: 'sess-1',
          timestamp: '2026-01-24T01:00:05.000Z',
          attachment: {
            type: 'queued_command',
            prompt: [{ type: 'text', text: 'Queued steer' }],
            source_uuid: 'queue-source-uuid',
            commandMode: 'prompt',
          },
        },
      ]

      await createSessionFile('test-agent', 'sess-1', entries)

      const result = await removeMessage('test-agent', 'sess-1', 'queue-source-uuid')
      expect(result).toBe(true)

      const remaining = await readSessionEntries('test-agent', 'sess-1')
      expect(remaining.length).toBe(1)
      expect(remaining[0].uuid).toBe('user-1')
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

    it('still returns promoted sessions (promotion does not remove from trigger page)', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'sess-1': {
          name: 'Promoted Run',
          createdAt: '2026-01-24T01:00:00.000Z',
          scheduledTaskId: 'task-abc',
          isScheduledExecution: true,
          promotedToInteractive: true,
        },
      })

      const sessions = await getSessionsByScheduledTask('test-agent', 'task-abc')
      expect(sessions.length).toBe(1)
      expect(sessions[0].id).toBe('sess-1')
    })
  })

  // ============================================================================
  // getSessionForScheduledExecution Tests
  // ============================================================================

  describe('getSessionForScheduledExecution', () => {
    it('returns the session for the exact scheduled task execution time', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'sess-2', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'sess-3', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'sess-1': {
          name: 'Earlier Run',
          createdAt: '2026-01-24T01:00:00.000Z',
          scheduledTaskId: 'task-abc',
          scheduledExecutionAt: '2026-01-24T01:00:00.000Z',
          isScheduledExecution: true,
        },
        'sess-2': {
          name: 'Target Run',
          createdAt: '2026-01-24T02:00:00.000Z',
          scheduledTaskId: 'task-abc',
          scheduledExecutionAt: '2026-01-24T02:00:00.000Z',
          isScheduledExecution: true,
        },
        'sess-3': {
          name: 'Different Task Same Time',
          createdAt: '2026-01-24T02:00:00.000Z',
          scheduledTaskId: 'task-xyz',
          scheduledExecutionAt: '2026-01-24T02:00:00.000Z',
          isScheduledExecution: true,
        },
      })

      const session = await getSessionForScheduledExecution(
        'test-agent',
        'task-abc',
        new Date('2026-01-24T02:00:00.000Z'),
      )

      expect(session?.id).toBe('sess-2')
    })

    it('returns null when the task matches but the execution time does not', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'sess-1': {
          name: 'Earlier Run',
          createdAt: '2026-01-24T01:00:00.000Z',
          scheduledTaskId: 'task-abc',
          scheduledExecutionAt: '2026-01-24T01:00:00.000Z',
          isScheduledExecution: true,
        },
      })

      const session = await getSessionForScheduledExecution(
        'test-agent',
        'task-abc',
        new Date('2026-01-24T02:00:00.000Z'),
      )

      expect(session).toBeNull()
    })
  })

  // ============================================================================
  // getSessionsByWebhookTrigger Tests
  // ============================================================================

  describe('getSessionsByWebhookTrigger', () => {
    it('still returns promoted sessions (promotion does not remove from trigger page)', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'sess-1': {
          name: 'Promoted Webhook Run',
          createdAt: '2026-01-24T01:00:00.000Z',
          webhookTriggerId: 'trigger-abc',
          isWebhookExecution: true,
          promotedToInteractive: true,
        },
      })

      const sessions = await getSessionsByWebhookTrigger('test-agent', 'trigger-abc')
      expect(sessions.length).toBe(1)
      expect(sessions[0].id).toBe('sess-1')
    })

    it('uses metadata createdAt instead of filesystem birthtime', async () => {
      await createSessionFile('test-agent', 'sess-1', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'sess-1': {
          name: 'Webhook Run',
          createdAt: '2026-07-30T19:44:31.000Z',
          webhookTriggerId: 'trigger-abc',
          isWebhookExecution: true,
        },
      })

      const sessions = await getSessionsByWebhookTrigger('test-agent', 'trigger-abc')
      expect(sessions).toHaveLength(1)
      expect(sessions[0].createdAt).toEqual(new Date('2026-07-30T19:44:31.000Z'))
    })
  })

  describe('listSessionsByIds', () => {
    it('returns info only for the requested ids without touching siblings', async () => {
      await createSessionFile('test-agent', 'wanted-1', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'wanted-2', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'other', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'wanted-1': { name: 'First', createdAt: '2026-01-01T00:00:00Z' },
      })

      const sessions = await listSessionsByIds('test-agent', ['wanted-1', 'wanted-2'])
      expect(sessions.map((s) => s.id).sort()).toEqual(['wanted-1', 'wanted-2'])
      const first = sessions.find((s) => s.id === 'wanted-1')
      expect(first?.name).toBe('First')
      expect(first?.createdAt).toEqual(new Date('2026-01-01T00:00:00Z'))
    })

    it('dedupes repeated ids and skips ids with no transcript and no registration', async () => {
      await createSessionFile('test-agent', 'real', SAMPLE_JSONL_ENTRIES)

      const sessions = await listSessionsByIds('test-agent', ['real', 'real', 'ghost'])
      expect(sessions.map((s) => s.id)).toEqual(['real'])
    })

    it('skips unregistered empty transcripts (SDK subagent artifacts)', async () => {
      await createSessionFile('test-agent', 'artifact', [])
      await createSessionFile('test-agent', 'registered-empty', [])
      await createSessionMetadata('test-agent', {
        'registered-empty': { name: 'Empty but real', createdAt: '2026-01-01T00:00:00Z' },
      })

      const sessions = await listSessionsByIds('test-agent', ['artifact', 'registered-empty'])
      expect(sessions.map((s) => s.id)).toEqual(['registered-empty'])
    })

    it('excludes automated sessions unless promoted to interactive', async () => {
      await createSessionFile('test-agent', 'cron-run', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'promoted', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'chat-run', SAMPLE_JSONL_ENTRIES)
      await createSessionFile('test-agent', 'x-agent-run', SAMPLE_JSONL_ENTRIES)
      await createSessionMetadata('test-agent', {
        'cron-run': { createdAt: '2026-01-01T00:00:00Z', isScheduledExecution: true },
        promoted: { createdAt: '2026-01-01T00:00:00Z', isScheduledExecution: true, promotedToInteractive: true },
        'chat-run': { createdAt: '2026-01-01T00:00:00Z', isChatIntegrationSession: true },
        'x-agent-run': { createdAt: '2026-01-01T00:00:00Z', invokedByAgentSlug: 'caller-agent' },
      })

      const sessions = await listSessionsByIds(
        'test-agent',
        ['cron-run', 'promoted', 'chat-run', 'x-agent-run'],
        { excludeAutomated: true },
      )
      expect(sessions.map((s) => s.id)).toEqual(['promoted'])
    })

    it('falls back to registration metadata for sessions that have not streamed yet', async () => {
      await createSessionMetadata('test-agent', {
        'registered-only': { name: 'Brand new', createdAt: '2026-01-05T00:00:00Z' },
      })

      const sessions = await listSessionsByIds('test-agent', ['registered-only'])
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ id: 'registered-only', name: 'Brand new', messageCount: 0 })
      expect(sessions[0].lastActivityAt).toEqual(new Date('2026-01-05T00:00:00Z'))
    })

    it('returns an empty list for no ids without reading anything', async () => {
      // No directories were created for this agent at all — an eager metadata
      // read would throw or create paths as a side effect.
      await expect(listSessionsByIds('missing-agent', [])).resolves.toEqual([])
    })
  })
})
