import { describe, expect, it } from 'vitest'
import {
  pageTranscript,
  toTranscriptView,
  type CompactedMessage,
} from './x-agent-transcript-view'

const spoken = (content: string, role = 'assistant'): CompactedMessage => ({
  role,
  content,
  spoken: content,
})

const internal = (content: string, toolName?: string): CompactedMessage => ({
  role: toolName ? 'assistant' : 'user',
  content,
  spoken: '',
  ...(toolName ? { toolName } : {}),
})

describe('toTranscriptView', () => {
  it('keeps spoken turns and collapses a tool/thinking run into one stub', () => {
    const view = toTranscriptView(
      [
        spoken('Those two exclusions look like a demo false-positive.'),
        internal('[tool_use: Bash]', 'Bash'),
        internal('[tool_result] members […]'),
        internal('[thinking only — no text response]'),
        spoken('One banned signup that week has snapshot spend over $10.'),
      ],
      false,
    )
    expect(view).toEqual([
      { role: 'assistant', content: 'Those two exclusions look like a demo false-positive.' },
      { role: 'system', content: 'tool calls + thinking' },
      { role: 'assistant', content: 'One banned signup that week has snapshot spend over $10.' },
    ])
  })

  it('strips tool lines from a mixed spoken turn', () => {
    const view = toTranscriptView(
      [
        {
          role: 'assistant',
          content: 'hi\n[tool_use: Bash]',
          spoken: 'hi',
          toolName: 'Bash',
        },
      ],
      false,
    )
    expect(view).toEqual([{ role: 'assistant', content: 'hi' }])
  })

  it('returns today compact view when fullTranscript is true', () => {
    const compacted: CompactedMessage[] = [
      spoken('hi'),
      internal('[tool_use: Bash]', 'Bash'),
    ]
    expect(toTranscriptView(compacted, true)).toEqual([
      { role: 'assistant', content: 'hi' },
      { role: 'assistant', content: '[tool_use: Bash]', toolName: 'Bash' },
    ])
  })
})

describe('pageTranscript', () => {
  const entries = [
    {
      type: 'assistant' as const,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'do not leak this' },
        ],
      },
    },
    {
      type: 'assistant' as const,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'secret' } }],
      },
    },
    {
      type: 'assistant' as const,
      message: { role: 'assistant', content: 'final' },
    },
  ]

  it('defaults to the quiet view and slices after it', () => {
    const page = pageTranscript(entries as never, { limit: 1 })
    expect(page.total).toBe(2)
    expect(page.messages).toEqual([{ role: 'assistant', content: 'final' }])
    expect(JSON.stringify(page)).not.toContain('do not leak this')
    expect(JSON.stringify(page)).not.toContain('secret')
  })

  it('counts thinking and tool_use as messages when fullTranscript is true', () => {
    const page = pageTranscript(entries as never, { fullTranscript: true, limit: 1 })
    expect(page.total).toBe(3)
    expect(page.messages).toEqual([{ role: 'assistant', content: 'final' }])
  })
})
