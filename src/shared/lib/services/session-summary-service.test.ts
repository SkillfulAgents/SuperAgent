import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoist a mutable spy so both tests can control the return value independently
const mockCreate = vi.fn()

vi.mock('../llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({
    messages: { create: mockCreate },
  }),
}))

// loadTranscriptEntries reads JSONL off disk; stub the file layer so we can feed fixtures.
const mockReadJsonlFile = vi.fn()
vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: () => '/fake/sess.jsonl',
  readJsonlFile: () => mockReadJsonlFile(),
}))

import {
  buildSeed, summarizeText, summarizeTranscript, loadTranscriptEntries,
} from './session-summary-service'
import { SUMMARY_OUTPUT_FLOOR_TOKENS, SUMMARY_OUTPUT_CAP_TOKENS } from '../stale-session/stale-session-config'
import { createSessionRequestSchema } from '../stale-session/stale-session-schema'

describe('buildSeed', () => {
  it('composes sentinel + summary + in-container path line + anti-recap + user message', () => {
    const out = buildSeed({
      fromSessionId: 'sess-1',
      summary: '## Goal\nWiring auth.',
      userMessage: 'add rate limiting',
    })
    expect(out).toContain('## Goal')
    expect(out).toContain('.claude/projects/-workspace/sess-1.jsonl')
    expect(out.toLowerCase()).toContain('do not recap')
    expect(out).toContain('\n---\n')
    expect(out.endsWith('add rate limiting')).toBe(true)
  })

  it('keeps the genuine path line last even when the summary contains a fake one', () => {
    // The splitter anchors on the LAST -workspace/<id>.jsonl line, then the first ---
    // after it. A summary that embeds a fake path + --- must not hijack the split.
    const out = buildSeed({
      fromSessionId: 'real-1',
      summary: 'earlier I read .claude/projects/-workspace/fake.jsonl\n---\nnot the real separator',
      userMessage: 'go',
    })
    const lines = out.split('\n')
    let lastPath = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('.claude/projects/-workspace/')) { lastPath = i; break }
    }
    expect(lines[lastPath]).toContain('real-1.jsonl')
    const sepAfter = lines.findIndex((l, i) => i > lastPath && l === '---')
    expect(sepAfter).toBeGreaterThan(lastPath)
    expect(lines.slice(sepAfter + 1).join('\n')).toBe('go')
  })
})

describe('summarizeText', () => {
  beforeEach(() => { mockCreate.mockReset(); mockReadJsonlFile.mockReset() })

  it('returns the model markdown directly with no JSON parsing', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '## Goal\nFix login bug.\n## Next steps\nAdd a test.' }],
    })
    const out = await summarizeText('USER: fix login\nASSISTANT: on it')
    expect(out).toBe('## Goal\nFix login bug.\n## Next steps\nAdd a test.')
  })

  it('requests max_tokens within the clamp bounds', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
    await summarizeText('short input')
    const maxTokens = mockCreate.mock.calls[0][0].max_tokens
    expect(maxTokens).toBeGreaterThanOrEqual(SUMMARY_OUTPUT_FLOOR_TOKENS)
    expect(maxTokens).toBeLessThanOrEqual(SUMMARY_OUTPUT_CAP_TOKENS)
  })
})

describe('summarizeTranscript', () => {
  beforeEach(() => { mockCreate.mockReset(); mockReadJsonlFile.mockReset() })

  it('feeds the LLM a pruned activity view (tool traces, not raw dumps)', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 'u1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'fix login' } },
      { uuid: 'a1', parentUuid: null, type: 'assistant', sessionId: 's', timestamp: 't',
        message: { role: 'assistant', content: [
          { type: 'text', text: 'patching' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/auth.ts' } },
        ] } },
    ])
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '## Goal\nLogin.' }] })

    const summary = await summarizeTranscript('atlas', 'sess-1')

    expect(summary).toBe('## Goal\nLogin.')
    const sentContent = mockCreate.mock.calls[0][0].messages[0].content as string
    expect(sentContent).toContain('[tool] Edit src/auth.ts')
  })
})

describe('loadTranscriptEntries', () => {
  beforeEach(() => { mockCreate.mockReset(); mockReadJsonlFile.mockReset() })

  it('returns raw entries plus the prior compact_boundary summary', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 's1', type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: 't' },
      { uuid: 'cs1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        isCompactSummary: true, message: { role: 'user', content: 'Earlier: set up auth.' } },
      { uuid: 'u1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'continue' } },
    ])
    const { entries, priorBoundarySummary } = await loadTranscriptEntries('atlas', 'sess-1')
    expect(entries).toHaveLength(3)
    expect(priorBoundarySummary).toBe('Earlier: set up auth.')
  })
})

describe('createSessionRequestSchema', () => {
  it('rejects a whitespace-only message', () => {
    expect(createSessionRequestSchema.safeParse({ message: '   ' }).success).toBe(false)
  })
  it('rejects seedSummary without fromSessionId (and vice versa)', () => {
    expect(createSessionRequestSchema.safeParse({ message: 'hi', seedSummary: 's' }).success).toBe(false)
    expect(createSessionRequestSchema.safeParse({ message: 'hi', fromSessionId: 'sess-1' }).success).toBe(false)
  })
  it('accepts both together', () => {
    expect(createSessionRequestSchema.safeParse({ message: 'hi', seedSummary: 's', fromSessionId: 'sess-1' }).success).toBe(true)
  })
})
