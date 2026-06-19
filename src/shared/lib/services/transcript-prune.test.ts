import { describe, it, expect } from 'vitest'
import type { JsonlEntry } from '@shared/lib/types/agent'
import {
  pruneTranscript,
  budgetPrunedLines,
  renderPrunedLines,
  estTokens,
} from './transcript-prune'

const userMsg = (text: string): JsonlEntry => ({
  uuid: 'u', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
  message: { role: 'user', content: text },
}) as unknown as JsonlEntry

const assistantText = (text: string): JsonlEntry => ({
  uuid: 'a', parentUuid: null, type: 'assistant', sessionId: 's', timestamp: 't',
  message: { role: 'assistant', content: text },
}) as unknown as JsonlEntry

const assistantWithTool = (text: string, toolId: string, name: string, input: Record<string, unknown>): JsonlEntry => ({
  uuid: 'a', parentUuid: null, type: 'assistant', sessionId: 's', timestamp: 't',
  message: { role: 'assistant', content: [
    { type: 'text', text },
    { type: 'tool_use', id: toolId, name, input },
  ] },
}) as unknown as JsonlEntry

const toolResultUser = (toolId: string, content: string, isError = false): JsonlEntry => ({
  uuid: 'r', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: isError }] },
}) as unknown as JsonlEntry

// A tool_result user entry carrying structured stdout/stderr/interrupted on toolUseResult.
const structuredResultUser = (
  toolId: string,
  structured: { stdout?: string; stderr?: string; interrupted?: boolean },
): JsonlEntry => ({
  uuid: 'r', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: structured.stdout ?? '' }] },
  toolUseResult: { stdout: structured.stdout ?? '', stderr: structured.stderr ?? '', interrupted: !!structured.interrupted, isImage: false },
}) as unknown as JsonlEntry

const thinkingAssistant = (): JsonlEntry => ({
  uuid: 'th', parentUuid: null, type: 'assistant', sessionId: 's', timestamp: 't',
  message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret reasoning' }] },
}) as unknown as JsonlEntry

const queuedCommand = (text: string): JsonlEntry => ({
  uuid: 'q', type: 'attachment', timestamp: 't',
  attachment: { type: 'queued_command', prompt: text },
}) as unknown as JsonlEntry

const fileHistory = (): JsonlEntry => ({
  type: 'file-history-snapshot', messageId: 'm',
  snapshot: { messageId: 'm', trackedFileBackups: {}, timestamp: 't' },
}) as unknown as JsonlEntry

// A Task tool_result entry with empty content and a status field on toolUseResult.
const taskResultWithStatus = (toolId: string, status: string): JsonlEntry => ({
  uuid: 'r', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: '', is_error: false }] },
  toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, status },
}) as unknown as JsonlEntry

describe('pruneTranscript', () => {
  it('keeps user + assistant text', () => {
    const lines = pruneTranscript([userMsg('fix the login bug'), assistantText('found it in auth.ts')])
    expect(renderPrunedLines(lines)).toBe('USER: fix the login bug\nASSISTANT: found it in auth.ts')
  })

  it('renders a compact tool-call trace and joins an error result across entries', () => {
    const lines = pruneTranscript([
      assistantWithTool('patching', 't1', 'Edit', { file_path: 'src/auth.ts' }),
      toolResultUser('t1', 'ok'),
      assistantWithTool('testing', 't2', 'Bash', { command: 'npm test' }),
      toolResultUser('t2', 'FAILED 1 test', true),
    ])
    const text = renderPrunedLines(lines)
    expect(text).toContain('[tool] Edit src/auth.ts')
    expect(text).toContain('[tool] Bash: npm test')
    expect(text).toContain('-> error: FAILED 1 test')
  })

  it('surfaces stderr-only and interrupted failures from toolUseResult (not just is_error)', () => {
    const stderr = pruneTranscript([
      assistantWithTool('build', 't1', 'Bash', { command: 'npm run build' }),
      structuredResultUser('t1', { stdout: '', stderr: 'TypeError: boom' }),
    ])
    expect(renderPrunedLines(stderr)).toContain('-> stderr: TypeError: boom')

    const interrupted = pruneTranscript([
      assistantWithTool('serve', 't2', 'Bash', { command: 'npm run dev' }),
      structuredResultUser('t2', { stdout: 'partial', interrupted: true }),
    ])
    expect(renderPrunedLines(interrupted)).toContain('-> interrupted')
  })

  it('keeps a long Task/subagent result (final-state signal), capped', () => {
    const taskOut = 'Found 3 call sites: a.ts, b.ts, c.ts. ' + 'x'.repeat(2000)
    const lines = pruneTranscript([
      assistantWithTool('delegating', 't1', 'Task', { description: 'research auth' }),
      toolResultUser('t1', taskOut),
    ])
    const text = renderPrunedLines(lines)
    expect(text).toContain('[tool] Task: research auth')
    expect(text).toContain('Found 3 call sites')
    expect(text).toContain('[truncated]')
  })

  it('strips bulk successful Read output but keeps the call', () => {
    const big = 'x'.repeat(5000)
    const lines = pruneTranscript([
      assistantWithTool('reading', 't1', 'Read', { file_path: 'src/big.ts' }),
      toolResultUser('t1', big),
    ])
    const text = renderPrunedLines(lines)
    expect(text).toContain('[tool] Read src/big.ts')
    expect(text).not.toContain('xxxxx')
  })

  it('keeps queued_command steering as user text', () => {
    const lines = pruneTranscript([queuedCommand('actually use sonnet')])
    expect(renderPrunedLines(lines)).toBe('USER: actually use sonnet')
  })

  it('strips thinking blocks and file-history entries', () => {
    const lines = pruneTranscript([thinkingAssistant(), fileHistory(), userMsg('hello')])
    expect(renderPrunedLines(lines)).toBe('USER: hello')
  })

  it('skips tool-result-only user messages (their signal joins the call instead)', () => {
    const lines = pruneTranscript([toolResultUser('t9', 'orphan output')])
    expect(lines).toHaveLength(0)
  })

  it('joins multiple tool_use blocks by id within one assistant message', () => {
    // Build one assistant entry with two tool_use blocks
    const assistantMultiTool: JsonlEntry = {
      uuid: 'a',
      parentUuid: null,
      type: 'assistant',
      sessionId: 's',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/auth.ts' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    } as unknown as JsonlEntry

    // Build one user entry with two tool_result blocks (reversed order to test id-keying, not positional matching)
    const userMultiResult: JsonlEntry = {
      uuid: 'r',
      parentUuid: null,
      type: 'user',
      sessionId: 's',
      timestamp: 't',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't2', content: 'FAILED 1 test', is_error: true },
          { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
        ],
      },
    } as unknown as JsonlEntry

    const lines = pruneTranscript([assistantMultiTool, userMultiResult])
    const text = renderPrunedLines(lines)

    // Verify results are joined by id, not by position: each result should sit immediately after its matching call
    expect(text).toMatch(/\[tool\] Edit src\/auth\.ts\n\s*-> ok/)
    expect(text).toMatch(/\[tool\] Bash: npm test\n\s*-> error: FAILED 1 test/)
  })

  it('keeps a short successful non-bulk tool result as signal', () => {
    const lines = pruneTranscript([
      assistantWithTool('editing file', 't1', 'Edit', { file_path: 'src/x.ts' }),
      toolResultUser('t1', 'ok'),
    ])
    const text = renderPrunedLines(lines)
    expect(text).toContain('[tool] Edit src/x.ts')
    expect(text).toContain('-> ok')
  })

  it('notes a non-queued attachment as a one-line marker', () => {
    const imageAttachment: JsonlEntry = {
      uuid: 'img',
      type: 'attachment',
      timestamp: 't',
      attachment: { type: 'image' },
    } as unknown as JsonlEntry

    const lines = pruneTranscript([imageAttachment])
    const text = renderPrunedLines(lines)
    expect(text).toContain('[attachment: image]')
  })

  it('renderToolCall renders Grep and Glob with their pattern; unknown tool falls back to bare name', () => {
    const lines = pruneTranscript([
      assistantWithTool('searching', 't1', 'Grep', { pattern: 'foo.*bar' }),
      toolResultUser('t1', ''),
      assistantWithTool('globbing', 't2', 'Glob', { pattern: '**/*.ts' }),
      toolResultUser('t2', ''),
      assistantWithTool('calling', 't3', 'mcp__custom__tool', {}),
      toolResultUser('t3', ''),
    ])
    const text = renderPrunedLines(lines)
    expect(text).toContain('[tool] Grep foo.*bar')
    expect(text).toContain('[tool] Glob **/*.ts')
    expect(text).toContain('[tool] mcp__custom__tool')
  })

  it('tool_use with no matching tool_result renders just the call line without a signal', () => {
    const lines = pruneTranscript([
      assistantWithTool('reading', 't1', 'Read', { file_path: 'src/x.ts' }),
      // no toolResultUser for t1
    ])
    const text = renderPrunedLines(lines)
    expect(text).toContain('[tool] Read src/x.ts')
    expect(text).not.toContain('->')
  })

  it('Task with empty result body falls back to status when present, or "done" when absent', () => {
    const withStatus = pruneTranscript([
      assistantWithTool('delegating', 't1', 'Task', { description: 'audit auth' }),
      taskResultWithStatus('t1', 'completed'),
    ])
    expect(renderPrunedLines(withStatus)).toContain('-> completed')

    const withoutStatus = pruneTranscript([
      assistantWithTool('delegating', 't2', 'Task', { description: 'audit auth' }),
      toolResultUser('t2', ''),
    ])
    expect(renderPrunedLines(withoutStatus)).toContain('-> done')
  })

  it('caps a long successful result from a non-bulk tool with [truncated]', () => {
    const longBody = 'a'.repeat(600)
    const lines = pruneTranscript([
      assistantWithTool('fetching', 't1', 'WebFetch', { url: 'https://example.com' }),
      toolResultUser('t1', longBody),
    ])
    const text = renderPrunedLines(lines)
    expect(text).toContain('[tool] WebFetch')
    expect(text).toContain('[truncated]')
    expect(text).not.toContain(longBody)
  })

  it('queued_command with a ContentBlock[] prompt renders as USER text', () => {
    const blockEntry: JsonlEntry = {
      uuid: 'q', type: 'attachment', timestamp: 't',
      attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'refocus on auth' }] },
    } as unknown as JsonlEntry
    const lines = pruneTranscript([blockEntry])
    expect(renderPrunedLines(lines)).toBe('USER: refocus on auth')
  })

  it('empty transcript returns []', () => {
    expect(pruneTranscript([])).toEqual([])
  })

  it('isCompactSummary entries are skipped entirely', () => {
    const compactEntry: JsonlEntry = {
      uuid: 'cs', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
      isCompactSummary: true,
      message: { role: 'user', content: 'summary text' },
    } as unknown as JsonlEntry
    const lines = pruneTranscript([userMsg('before'), compactEntry, userMsg('after')])
    expect(renderPrunedLines(lines)).toBe('USER: before\nUSER: after')
  })
})

describe('budgetPrunedLines', () => {
  it('keeps newest lines within budget, returned chronologically', () => {
    const lines = pruneTranscript([userMsg('aaa'), userMsg('bbb'), userMsg('ccc')])
    // each line "USER: xxx" = 9 chars -> ceil(9/4) = 3 tokens; budget 6 keeps the last two
    const kept = budgetPrunedLines(lines, 6)
    expect(renderPrunedLines(kept)).toBe('USER: bbb\nUSER: ccc')
  })

  it('keeps at least one line even when it exceeds budget', () => {
    const lines = pruneTranscript([userMsg('a'.repeat(400))])
    expect(budgetPrunedLines(lines, 1)).toHaveLength(1)
  })

  it('drops oldest lines when budget is tight, preserving chronological order in result', () => {
    // "USER: aaaa" = 10 chars -> ceil(10/4) = 3 tokens each; 4 lines = 12 tokens total
    const lines = pruneTranscript([userMsg('aaaa'), userMsg('bbbb'), userMsg('cccc'), userMsg('dddd')])
    // budget 6 fits only 2 lines (newest two); result is still oldest-first
    const kept = budgetPrunedLines(lines, 6)
    expect(kept).toHaveLength(2)
    expect(renderPrunedLines(kept)).toBe('USER: cccc\nUSER: dddd')
  })
})

describe('estTokens', () => {
  it('approximates 4 chars per token', () => {
    expect(estTokens('abcd')).toBe(1)
    expect(estTokens('abcde')).toBe(2)
  })
})
