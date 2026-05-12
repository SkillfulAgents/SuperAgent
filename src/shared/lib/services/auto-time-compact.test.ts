import { describe, it, expect } from 'vitest'
import { formatSummary } from './auto-time-compact'
import type { JsonlEntry, JsonlMessageEntry } from '@shared/lib/types/agent'

/**
 * Test fixtures use type assertion because JsonlMessageEntry has many
 * fields the SDK populates that aren't relevant for summary formatting.
 * We only set what `formatSummary` actually reads.
 */

function userText(uuid: string, text: string): JsonlMessageEntry {
  return {
    uuid,
    parentUuid: null,
    type: 'user',
    sessionId: 's',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  } as JsonlMessageEntry
}

function assistantText(uuid: string, text: string, model = 'claude-3-5'): JsonlMessageEntry {
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    sessionId: 's',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
    },
  } as unknown as JsonlMessageEntry
}

function assistantToolUse(
  uuid: string,
  toolId: string,
  name: string,
  input: Record<string, unknown> = {},
  alsoText?: string
): JsonlMessageEntry {
  const content: unknown[] = []
  if (alsoText) content.push({ type: 'text', text: alsoText })
  content.push({ type: 'tool_use', id: toolId, name, input })
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    sessionId: 's',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'assistant', model: 'claude-3-5', content },
  } as unknown as JsonlMessageEntry
}

function userToolResult(uuid: string, toolUseId: string, result: string): JsonlMessageEntry {
  return {
    uuid,
    parentUuid: null,
    type: 'user',
    sessionId: 's',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
    },
  } as unknown as JsonlMessageEntry
}

/** The header line literally mentions "[...]" — strip it so body-level
 *  assertions about placeholders don't false-match. */
function body(summary: string): string {
  const lines = summary.split('\n')
  return lines.slice(1).join('\n')
}

describe('auto-time-compact formatSummary', () => {
  it('returns just the header when entries is empty', () => {
    const out = formatSummary([], 10)
    expect(out).toContain('[auto-time-compact]')
    expect(out).not.toContain('User:')
    expect(out).not.toContain('Assistant:')
  })

  it('preserves all user/assistant text when there are no tool calls', () => {
    const entries: JsonlEntry[] = [
      userText('u1', 'hello'),
      assistantText('a1', 'hi there'),
      userText('u2', 'how are you'),
      assistantText('a2', 'good thanks'),
    ]
    const out = formatSummary(entries, 10)
    expect(out).toContain('User: hello')
    expect(out).toContain('Assistant: hi there')
    expect(out).toContain('User: how are you')
    expect(out).toContain('Assistant: good thanks')
    expect(body(out)).not.toContain('[...]')
    expect(body(out)).not.toContain('[tool_use')
  })

  it('keeps every tool call verbatim when there are fewer than keepLastTools', () => {
    const entries: JsonlEntry[] = [
      userText('u1', 'do things'),
      assistantToolUse('a1', 't1', 'Bash', { command: 'ls' }),
      userToolResult('r1', 't1', 'file1\nfile2'),
      assistantToolUse('a2', 't2', 'Read', { path: '/a' }),
      userToolResult('r2', 't2', 'content of a'),
    ]
    const out = formatSummary(entries, 10)
    expect(out).toContain('[tool_use: Bash] {"command":"ls"}')
    expect(out).toContain('[tool_result] file1\nfile2')
    expect(out).toContain('[tool_use: Read] {"path":"/a"}')
    expect(out).toContain('[tool_result] content of a')
    expect(body(out)).not.toContain('[...]')
  })

  it('collapses older tool calls into [...] when over the cap', () => {
    const tools: JsonlMessageEntry[] = []
    for (let i = 1; i <= 5; i++) {
      tools.push(assistantToolUse(`a${i}`, `t${i}`, 'Bash', { i }))
      tools.push(userToolResult(`r${i}`, `t${i}`, `result ${i}`))
    }
    const entries: JsonlEntry[] = [userText('u1', 'start'), ...tools]

    const out = formatSummary(entries, 2)
    const b = body(out)
    // First 3 tool calls (t1..t3) collapse, t4 and t5 verbatim
    expect(b).toContain('[...]')
    expect(b).not.toContain('[tool_use: Bash] {"i":1}')
    expect(b).not.toContain('[tool_use: Bash] {"i":3}')
    expect(b).toContain('[tool_use: Bash] {"i":4}')
    expect(b).toContain('[tool_use: Bash] {"i":5}')
    expect(b).toContain('[tool_result] result 4')
    expect(b).toContain('[tool_result] result 5')
    // The text turn itself is always preserved
    expect(b).toContain('User: start')
  })

  it('routes a tool_result by its tool_use_id, not by position', () => {
    // Older tool (t1) + recent tool (t2). The recent tool_use should
    // appear verbatim; its result (which arrives later in the stream)
    // should also appear verbatim because tool_use_id matches.
    const entries: JsonlEntry[] = [
      assistantToolUse('a1', 't1', 'Bash', { i: 1 }),
      userToolResult('r1', 't1', 'old'),
      assistantToolUse('a2', 't2', 'Read', { path: 'x' }),
      userToolResult('r2', 't2', 'new'),
    ]
    const out = formatSummary(entries, 1)
    const b = body(out)
    expect(b).toContain('[tool_use: Read]')
    expect(b).toContain('[tool_result] new')
    expect(b).not.toContain('[tool_result] old')
  })

  it('skips SDK-synthetic assistant fillers', () => {
    const entries: JsonlEntry[] = [
      userText('u1', 'hi'),
      assistantText('a1', 'No response requested.', '<synthetic>'),
      userText('u2', 'real follow-up'),
      assistantText('a2', 'a real reply'),
    ]
    const out = formatSummary(entries, 10)
    expect(out).not.toContain('No response requested.')
    expect(out).toContain('User: real follow-up')
    expect(out).toContain('Assistant: a real reply')
  })

  it('skips isCompactSummary user messages (so prior summaries do not nest)', () => {
    const priorSummary = userText('prior-summary', 'PRIOR SUMMARY CONTENT')
    ;(priorSummary as unknown as { isCompactSummary: boolean }).isCompactSummary = true

    const entries: JsonlEntry[] = [
      priorSummary,
      userText('u1', 'after prior compact'),
      assistantText('a1', 'sure'),
    ]
    const out = formatSummary(entries, 10)
    expect(out).not.toContain('PRIOR SUMMARY CONTENT')
    expect(out).toContain('User: after prior compact')
  })
})
