import { describe, expect, it } from 'vitest'
import {
  collectDeliveredFiles,
  pageTranscript,
  toTranscriptView,
  type CompactedMessage,
} from './x-agent-transcript-view'

type Entry = Parameters<typeof collectDeliveredFiles>[0][number]

const assistantEntry = (
  uuid: string,
  messageId: string,
  calls: Array<{ id: string; name?: string; input: unknown }>,
): Entry => ({
  uuid,
  parentUuid: null,
  type: 'assistant',
  sessionId: 'session-1',
  timestamp: '2026-09-12T10:00:00.000Z',
  message: {
    role: 'assistant',
    id: messageId,
    content: calls.map((call) => ({
      type: 'tool_use',
      id: call.id,
      name: call.name ?? 'mcp__user-input__deliver_file',
      input: call.input,
    })),
  },
} as Entry)

const resultEntry = (
  uuid: string,
  toolUseId: string,
  content: unknown,
  isError = false,
  stdout?: string,
): Entry => ({
  uuid,
  parentUuid: null,
  type: 'user',
  sessionId: 'session-1',
  timestamp: '2026-09-12T10:00:01.000Z',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
  },
  ...(stdout !== undefined
    ? { toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false } }
    : {}),
} as Entry)

const currentResult = (sizeBytes: number, proseSize = sizeBytes): string =>
  `File "output.bin" (${proseSize} bytes) has been delivered to the user.\n\nDelivered: {"sizeBytes":${sizeBytes}}`

const currentResultWithHash = (sizeBytes: number, sha256: string): string =>
  `File "output.bin" (${sizeBytes} bytes) has been delivered to the user.\n\nDelivered: ${JSON.stringify({ sizeBytes, sha256 })}`

const legacyResult = (filename: string, sizeBytes: number): string =>
  `File "${filename}" (${sizeBytes} bytes) has been delivered to the user.`

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

describe('collectDeliveredFiles', () => {
  it('projects exact successful deliver_file calls and prefers current result metadata', () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [
        {
          id: 'delivery-1',
          input: { filePath: '/workspace/output/report.pdf', description: 'Quarterly report' },
        },
        { id: 'other-1', name: 'deliver_file', input: { filePath: '/workspace/not-included.txt' } },
      ]),
      resultEntry('result-1', 'delivery-1', currentResult(12345, 999)),
      resultEntry('result-2', 'other-1', currentResult(10)),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([{
      deliveryId: 'delivery-1',
      filename: 'report.pdf',
      description: 'Quarterly report',
      sizeBytes: 12345,
    }])
  })

  it('projects current delivery integrity metadata', () => {
    const sha256 = 'b'.repeat(64)
    const entries = [
      assistantEntry('assistant-1', 'message-1', [{
        id: 'delivery-1',
        input: { filePath: '/workspace/output.bin' },
      }]),
      resultEntry('result-1', 'delivery-1', currentResultWithHash(42, sha256)),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([expect.objectContaining({ sizeBytes: 42, sha256 })])
  })

  it('accepts legacy prose in block-array results and safely represents traversal-looking names', () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [{
        id: 'delivery-1',
        input: { filePath: '..\\..\\private/<draft>.csv' },
      }]),
      resultEntry('result-1', 'delivery-1', [
        { type: 'image', data: 'ignored' },
        { type: 'text', text: legacyResult('../../private/<draft>.csv', 42) },
      ]),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([{
      deliveryId: 'delivery-1',
      filename: '_draft_.csv',
      sizeBytes: 42,
    }])
  })

  it('deduplicates replayed UUIDs and tool IDs while preserving same-path distinct deliveries', () => {
    const firstCall = assistantEntry('assistant-1', 'message-1', [{
      id: 'delivery-1',
      input: { filePath: '/workspace/same.csv' },
    }])
    const firstResult = resultEntry('result-1', 'delivery-1', currentResult(10))
    const entries = [
      firstCall,
      firstResult,
      firstCall,
      firstResult,
      assistantEntry('assistant-2', 'message-2', [{
        id: 'delivery-1',
        input: { filePath: '/workspace/same.csv' },
      }]),
      assistantEntry('assistant-3', 'message-3', [{
        id: 'delivery-2',
        input: { filePath: '/workspace/same.csv' },
      }]),
      resultEntry('result-2', 'delivery-2', currentResult(20)),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([
      { deliveryId: 'delivery-1', filename: 'same.csv', sizeBytes: 10 },
      { deliveryId: 'delivery-2', filename: 'same.csv', sizeBytes: 20 },
    ])
  })

  it('excludes malformed inputs even when their results succeeded', () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [
        { id: 'missing-path', input: { description: 'No path' } },
        { id: 'wrong-path-type', input: { filePath: 123 } },
        { id: 'empty-path', input: { filePath: '' } },
        { id: 'wrong-description-type', input: { filePath: '/workspace/a.txt', description: 123 } },
      ]),
      resultEntry('result-1', 'missing-path', currentResult(1)),
      resultEntry('result-2', 'wrong-path-type', currentResult(2)),
      resultEntry('result-3', 'empty-path', currentResult(3)),
      resultEntry('result-4', 'wrong-description-type', currentResult(4)),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([])
  })

  it('excludes unresolved, errored, orphaned, and sizeless results', () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [
        { id: 'unresolved', input: { filePath: '/workspace/unresolved.txt' } },
        { id: 'errored', input: { filePath: '/workspace/errored.txt' } },
        { id: 'sizeless', input: { filePath: '/workspace/sizeless.txt' } },
      ]),
      resultEntry('result-1', 'errored', 'Error: missing', true),
      resultEntry('result-2', 'orphaned', currentResult(2)),
      resultEntry('result-3', 'sizeless', 'Delivered successfully'),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([])
  })

  it('uses transformed result metadata and remains independent of transcript pagination', () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [{
        id: 'delivery-1',
        input: { filePath: '/workspace/first.txt' },
      }]),
      resultEntry('result-1', 'delivery-1', legacyResult('first.txt', 1), false, currentResult(101)),
      { ...assistantEntry('assistant-2', 'message-2', []), message: { role: 'assistant', content: 'latest' } },
    ] as Entry[]

    expect(pageTranscript(entries, { limit: 1 }).messages).toEqual([
      { role: 'assistant', content: 'latest' },
    ])
    expect(collectDeliveredFiles(entries)).toEqual([
      { deliveryId: 'delivery-1', filename: 'first.txt', sizeBytes: 101 },
    ])
  })
})
