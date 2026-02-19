import { describe, it, expect } from 'vitest'
import {
  transformMessages,
  isToolResultOnlyMessage,
  parseCommandMessage,
  TransformedMessage,
} from './message-transform'
import { JsonlMessageEntry, ContentBlock } from '@shared/lib/types/agent'

/** Helper to narrow TransformedItem to TransformedMessage in tests */
function asMessage(item: unknown): TransformedMessage {
  return item as TransformedMessage
}

// ============================================================================
// Test Fixtures
// ============================================================================

function createUserMessage(
  uuid: string,
  content: string | ContentBlock[],
  timestamp: string = '2026-01-24T10:00:00.000Z',
  extras: Partial<JsonlMessageEntry> = {}
): JsonlMessageEntry {
  return {
    type: 'user',
    uuid,
    timestamp,
    sessionId: 'test-session',
    parentUuid: null,
    message: {
      role: 'user',
      content,
    },
    ...extras,
  }
}

function createAssistantMessage(
  uuid: string,
  messageId: string,
  content: ContentBlock[],
  timestamp: string = '2026-01-24T10:00:01.000Z'
): JsonlMessageEntry {
  return {
    type: 'assistant',
    uuid,
    timestamp,
    sessionId: 'test-session',
    parentUuid: null,
    message: {
      role: 'assistant',
      id: messageId,
      content,
    },
  }
}

// ============================================================================
// isToolResultOnlyMessage Tests
// ============================================================================

describe('isToolResultOnlyMessage', () => {
  it('returns false for assistant messages', () => {
    const entry = createAssistantMessage('uuid-1', 'msg-1', [
      { type: 'text', text: 'Hello' },
    ])
    expect(isToolResultOnlyMessage(entry)).toBe(false)
  })

  it('returns false for user messages with text content', () => {
    const entry = createUserMessage('uuid-1', 'Hello')
    expect(isToolResultOnlyMessage(entry)).toBe(false)
  })

  it('returns false for user messages with text blocks', () => {
    const entry = createUserMessage('uuid-1', [{ type: 'text', text: 'Hello' }])
    expect(isToolResultOnlyMessage(entry)).toBe(false)
  })

  it('returns true for user messages with only tool_result blocks', () => {
    const entry = createUserMessage('uuid-1', [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
    ])
    expect(isToolResultOnlyMessage(entry)).toBe(true)
  })

  it('returns true for user messages with multiple tool_result blocks', () => {
    const entry = createUserMessage('uuid-1', [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result 1' },
      { type: 'tool_result', tool_use_id: 'tool-2', content: 'result 2' },
    ])
    expect(isToolResultOnlyMessage(entry)).toBe(true)
  })

  it('returns false for mixed content (text + tool_result)', () => {
    const entry = createUserMessage('uuid-1', [
      { type: 'text', text: 'Some text' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
    ])
    expect(isToolResultOnlyMessage(entry)).toBe(false)
  })
})

// ============================================================================
// transformMessages - Basic Transformation Tests
// ============================================================================

describe('transformMessages', () => {
  describe('basic transformation', () => {
    it('transforms a simple user message with string content', () => {
      const entries: JsonlMessageEntry[] = [createUserMessage('uuid-1', 'Hello world')]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'uuid-1',
        type: 'user',
        content: { text: 'Hello world' },
        toolCalls: [],
      })
    })

    it('transforms a simple assistant message with text block', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [{ type: 'text', text: 'Hello!' }]),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'uuid-1',
        type: 'assistant',
        content: { text: 'Hello!' },
        toolCalls: [],
      })
    })

    it('preserves message order', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1', 'Question?', '2026-01-24T10:00:00.000Z'),
        createAssistantMessage(
          'uuid-2',
          'msg-1',
          [{ type: 'text', text: 'Answer!' }],
          '2026-01-24T10:00:01.000Z'
        ),
        createUserMessage('uuid-3', 'Follow-up?', '2026-01-24T10:00:02.000Z'),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(3)
      expect(result[0].id).toBe('uuid-1')
      expect(result[1].id).toBe('uuid-2')
      expect(result[2].id).toBe('uuid-3')
    })

    it('concatenates multiple text blocks', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'text', text: 'First ' },
          { type: 'text', text: 'Second' },
        ]),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).content.text).toBe('First Second')
    })
  })

  // ============================================================================
  // transformMessages - Assistant Message Merging Tests
  // ============================================================================

  describe('assistant message merging', () => {
    it('merges assistant messages with same message.id', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage(
          'uuid-1',
          'msg-shared',
          [{ type: 'text', text: "I'll help you." }],
          '2026-01-24T10:00:00.000Z'
        ),
        createAssistantMessage(
          'uuid-2',
          'msg-shared', // Same message.id!
          [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
          '2026-01-24T10:00:01.000Z'
        ),
      ]

      const result = transformMessages(entries)

      // Should merge into ONE message
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'uuid-1', // Keeps first UUID
        type: 'assistant',
        content: { text: "I'll help you." },
        toolCalls: [{ id: 'tool-1', name: 'Bash' }],
      })
    })

    it('preserves timestamp of first entry when merging', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage(
          'uuid-1',
          'msg-shared',
          [{ type: 'text', text: 'Text' }],
          '2026-01-24T10:00:00.000Z'
        ),
        createAssistantMessage(
          'uuid-2',
          'msg-shared',
          [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
          '2026-01-24T10:00:05.000Z' // Later timestamp
        ),
      ]

      const result = transformMessages(entries)

      expect(result[0].createdAt).toEqual(new Date('2026-01-24T10:00:00.000Z'))
    })

    it('does not merge messages with different message.id', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [{ type: 'text', text: 'First' }]),
        createAssistantMessage('uuid-2', 'msg-2', [{ type: 'text', text: 'Second' }]),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(2)
      expect(asMessage(result[0]).content.text).toBe('First')
      expect(asMessage(result[1]).content.text).toBe('Second')
    })

    it('handles three-way merge (text + tool_use + more text)', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-shared', [{ type: 'text', text: 'Starting. ' }]),
        createAssistantMessage('uuid-2', 'msg-shared', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ]),
        createAssistantMessage('uuid-3', 'msg-shared', [{ type: 'text', text: 'Done!' }]),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).content.text).toBe('Starting. Done!')
      expect(asMessage(result[0]).toolCalls).toHaveLength(1)
    })

    it('does not mutate original entries when merging', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-shared', [{ type: 'text', text: 'Text' }]),
        createAssistantMessage('uuid-2', 'msg-shared', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
        ]),
      ]

      // Store original content lengths
      const originalLength1 = (entries[0].message.content as unknown[]).length
      const originalLength2 = (entries[1].message.content as unknown[]).length

      transformMessages(entries)

      // Original entries should be unchanged
      expect((entries[0].message.content as unknown[]).length).toBe(originalLength1)
      expect((entries[1].message.content as unknown[]).length).toBe(originalLength2)
    })
  })

  // ============================================================================
  // transformMessages - Tool Results Tests
  // ============================================================================

  describe('tool results', () => {
    it('attaches tool result to tool call', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo hello' } },
        ]),
        createUserMessage('uuid-2', [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'hello' },
        ]),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1) // Tool result message is filtered out
      expect(asMessage(result[0]).toolCalls[0].result).toBe('hello')
      expect(asMessage(result[0]).toolCalls[0].isError).toBe(false)
    })

    it('attaches error tool result', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'invalid' } },
        ]),
        createUserMessage('uuid-2', [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'command not found', is_error: true },
        ]),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).toolCalls[0].result).toBe('command not found')
      expect(asMessage(result[0]).toolCalls[0].isError).toBe(true)
    })

    it('preserves empty string as valid result (mkdir has no output)', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'mkdir foo' } },
        ]),
        createUserMessage(
          'uuid-2',
          [{ type: 'tool_result', tool_use_id: 'tool-1', content: '' }],
          '2026-01-24T10:00:02.000Z',
          { toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false } }
        ),
      ]

      const result = transformMessages(entries)

      // Empty string should be preserved, NOT undefined
      expect(asMessage(result[0]).toolCalls[0].result).toBe('')
    })

    it('prefers toolUseResult.stdout over content', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ]),
        createUserMessage(
          'uuid-2',
          [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file1\nfile2' }],
          '2026-01-24T10:00:02.000Z',
          {
            toolUseResult: {
              stdout: 'file1\nfile2\nfile3', // More complete output
              stderr: '',
              interrupted: false,
              isImage: false,
            },
          }
        ),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).toolCalls[0].result).toBe('file1\nfile2\nfile3')
    })

    it('handles multiple tool calls with results', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'whoami' } },
        ]),
        createUserMessage('uuid-2', [
          { type: 'tool_result', tool_use_id: 'tool-1', content: '/home/user' },
          { type: 'tool_result', tool_use_id: 'tool-2', content: 'user' },
        ]),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).toolCalls).toHaveLength(2)
      expect(asMessage(result[0]).toolCalls[0].result).toBe('/home/user')
      expect(asMessage(result[0]).toolCalls[1].result).toBe('user')
    })

    it('handles tool call without result yet (pending)', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 10' } },
        ]),
        // No tool result entry yet
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).toolCalls[0].result).toBeUndefined()
    })
  })

  // ============================================================================
  // transformMessages - Tool Result Filtering Tests
  // ============================================================================

  describe('tool result message filtering', () => {
    it('filters out user messages that only contain tool results', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1', 'Hello'),
        createAssistantMessage('uuid-2', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
        ]),
        createUserMessage('uuid-3', [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'output' },
        ]),
        createUserMessage('uuid-4', 'Follow up question'),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(3)
      expect(result.map((m) => m.id)).toEqual(['uuid-1', 'uuid-2', 'uuid-4'])
    })

    it('keeps user messages with mixed content', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1', [
          { type: 'text', text: 'Here is the result:' },
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'output' },
        ]),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).content.text).toBe('Here is the result:')
    })
  })

  // ============================================================================
  // transformMessages - Real-World Scenarios
  // ============================================================================

  describe('real-world scenarios', () => {
    it('handles Gmail account request flow (the original bug)', () => {
      // This is the exact scenario that caused the duplicate message bug
      const entries: JsonlMessageEntry[] = [
        createUserMessage(
          'uuid-user',
          'Can you check my gmail?',
          '2026-01-24T18:48:32.902Z'
        ),
        // Claude SDK writes text first...
        createAssistantMessage(
          'uuid-asst-1',
          'msg_014NsRV6Mb32r3Eojy7efSh7',
          [{ type: 'text', text: "I'll help you check your Gmail inbox." }],
          '2026-01-24T18:48:35.550Z'
        ),
        // ...then tool_use in a separate entry with SAME message.id
        createAssistantMessage(
          'uuid-asst-2',
          'msg_014NsRV6Mb32r3Eojy7efSh7',
          [
            {
              type: 'tool_use',
              id: 'toolu_01NND',
              name: 'mcp__user-input__request_connected_account',
              input: { toolkit: 'gmail', reason: 'To check your inbox' },
            },
          ],
          '2026-01-24T18:48:36.277Z'
        ),
      ]

      const result = transformMessages(entries)

      // Should have exactly 2 messages: user + merged assistant
      expect(result).toHaveLength(2)

      // User message
      expect(result[0]).toMatchObject({
        id: 'uuid-user',
        type: 'user',
        content: { text: 'Can you check my gmail?' },
      })

      // Merged assistant message with BOTH text and tool call
      expect(result[1]).toMatchObject({
        id: 'uuid-asst-1', // First UUID preserved
        type: 'assistant',
        content: { text: "I'll help you check your Gmail inbox." },
      })
      expect(asMessage(result[1]).toolCalls).toHaveLength(1)
      expect(asMessage(result[1]).toolCalls[0].name).toBe('mcp__user-input__request_connected_account')
      expect(result[1].createdAt).toEqual(new Date('2026-01-24T18:48:35.550Z'))
    })

    it('handles full conversation with multiple tool calls', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('u1', 'List files and show current directory'),
        createAssistantMessage('a1', 'msg-1', [
          { type: 'text', text: "I'll run two commands." },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pwd' } },
        ]),
        createUserMessage('r1', [
          { type: 'tool_result', tool_use_id: 't1', content: 'file1.txt\nfile2.txt' },
          { type: 'tool_result', tool_use_id: 't2', content: '/home/user' },
        ]),
        createAssistantMessage('a2', 'msg-2', [
          { type: 'text', text: 'Here are the results...' },
        ]),
        createUserMessage('u2', 'Thanks!'),
        createAssistantMessage('a3', 'msg-3', [{ type: 'text', text: "You're welcome!" }]),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(5)
      expect(result.map((m) => m.id)).toEqual(['u1', 'a1', 'a2', 'u2', 'a3'])

      // Check tool results are attached
      expect(asMessage(result[1]).toolCalls[0].result).toBe('file1.txt\nfile2.txt')
      expect(asMessage(result[1]).toolCalls[1].result).toBe('/home/user')
    })
  })

  // ============================================================================
  // transformMessages - Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('handles empty entries array', () => {
      const result = transformMessages([])
      expect(result).toEqual([])
    })

    it('handles assistant message without message.id (no merging)', () => {
      // Some edge cases might have assistant messages without id
      const entryWithoutId: JsonlMessageEntry = {
        type: 'assistant',
        uuid: 'uuid-1',
        timestamp: '2026-01-24T10:00:00.000Z',
        sessionId: 'test-session',
        parentUuid: null,
        message: {
          role: 'assistant',
          // No id field!
          content: [{ type: 'text', text: 'Hello' }],
        },
      }

      const result = transformMessages([entryWithoutId])

      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).content.text).toBe('Hello')
    })

    it('ignores thinking blocks in content', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'thinking', thinking: 'Let me think about this...' } as ContentBlock,
          { type: 'text', text: 'Here is my answer.' },
        ]),
      ]

      const result = transformMessages(entries)

      // Thinking block should be ignored, only text extracted
      expect(asMessage(result[0]).content.text).toBe('Here is my answer.')
      expect(asMessage(result[0]).toolCalls).toHaveLength(0)
    })

    it('handles tool result for non-existent tool (orphaned result)', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'text', text: 'No tools here' },
        ]),
        createUserMessage('uuid-2', [
          { type: 'tool_result', tool_use_id: 'orphan-tool', content: 'orphaned result' },
        ]),
      ]

      const result = transformMessages(entries)

      // Should not crash, orphaned result is just ignored
      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).toolCalls).toHaveLength(0)
    })

    it('handles tool_result appearing before tool_use in entries', () => {
      // This shouldn't happen in practice, but let's be defensive
      const entries: JsonlMessageEntry[] = [
        // Result comes first (weird but possible if entries are out of order)
        createUserMessage('uuid-1', [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
        ]),
        createAssistantMessage('uuid-2', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
        ]),
      ]

      const result = transformMessages(entries)

      // Should still attach the result correctly
      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).toolCalls[0].result).toBe('result')
    })

    it('handles assistant message with string content (legacy format)', () => {
      const entry: JsonlMessageEntry = {
        type: 'assistant',
        uuid: 'uuid-1',
        timestamp: '2026-01-24T10:00:00.000Z',
        sessionId: 'test-session',
        parentUuid: null,
        message: {
          role: 'assistant',
          id: 'msg-1',
          content: 'Plain string content' as unknown as ContentBlock[],
        },
      }

      const result = transformMessages([entry])

      expect(asMessage(result[0]).content.text).toBe('Plain string content')
    })

    it('handles multiple tool results for same tool (last wins)', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
        ]),
        createUserMessage('uuid-2', [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'first result' },
        ]),
        createUserMessage('uuid-3', [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'second result' },
        ]),
      ]

      const result = transformMessages(entries)

      // Last result should win
      expect(asMessage(result[0]).toolCalls[0].result).toBe('second result')
    })

    it('handles message with only thinking block (no visible content)', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'thinking', thinking: 'Deep thoughts...' } as ContentBlock,
        ]),
      ]

      const result = transformMessages(entries)

      // Should produce a message with empty text
      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).content.text).toBe('')
      expect(asMessage(result[0]).toolCalls).toHaveLength(0)
    })

    it('handles unicode and special characters in text', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1', 'Hello 👋 世界 \n\t "quotes" & <tags>'),
        createAssistantMessage('uuid-2', 'msg-1', [
          { type: 'text', text: 'Response: émojis 🎉 and spëcial çhars' },
        ]),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).content.text).toBe('Hello 👋 世界 \n\t "quotes" & <tags>')
      expect(asMessage(result[1]).content.text).toBe('Response: émojis 🎉 and spëcial çhars')
    })

    it('handles deeply nested tool input', () => {
      const complexInput = {
        nested: {
          deeply: {
            value: [1, 2, { more: 'nesting' }],
          },
        },
        array: [{ a: 1 }, { b: 2 }],
      }

      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'ComplexTool', input: complexInput },
        ]),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).toolCalls[0].input).toEqual(complexInput)
    })

    it('handles interleaved messages from multiple assistant responses', () => {
      // Simulates concurrent or interleaved streaming
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-A', [{ type: 'text', text: 'A1 ' }]),
        createAssistantMessage('uuid-2', 'msg-B', [{ type: 'text', text: 'B1 ' }]),
        createAssistantMessage('uuid-3', 'msg-A', [{ type: 'text', text: 'A2' }]),
        createAssistantMessage('uuid-4', 'msg-B', [{ type: 'text', text: 'B2' }]),
      ]

      const result = transformMessages(entries)

      // Should merge by message.id correctly even when interleaved
      expect(result).toHaveLength(2)
      expect(asMessage(result[0]).content.text).toBe('A1 A2')
      expect(asMessage(result[1]).content.text).toBe('B1 B2')
    })

    it('preserves order when mixing user and merged assistant messages', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('u1', 'First question', '2026-01-24T10:00:00.000Z'),
        createAssistantMessage('a1', 'msg-1', [{ type: 'text', text: 'Part 1' }], '2026-01-24T10:00:01.000Z'),
        createAssistantMessage('a2', 'msg-1', [{ type: 'text', text: ' Part 2' }], '2026-01-24T10:00:02.000Z'),
        createUserMessage('u2', 'Second question', '2026-01-24T10:00:03.000Z'),
        createAssistantMessage('a3', 'msg-2', [{ type: 'text', text: 'Answer 2' }], '2026-01-24T10:00:04.000Z'),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(4)
      expect(result.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a3'])
      expect(asMessage(result[1]).content.text).toBe('Part 1 Part 2')
    })
  })

  // ============================================================================
  // transformMessages - Subagent Metadata Extraction Tests
  // ============================================================================

  describe('subagent metadata extraction', () => {
    it('extracts subagent metadata from Task tool result with agentId', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Task', input: { subagent_type: 'Explore', description: 'search codebase' } },
        ]),
        createUserMessage(
          'uuid-2',
          [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Found 3 files' }],
          '2026-01-24T10:00:02.000Z',
          {
            toolUseResult: {
              stdout: 'Found 3 files',
              stderr: '',
              interrupted: false,
              isImage: false,
              agentId: 'abc123',
              status: 'completed',
              totalDurationMs: 45000,
              totalTokens: 12500,
              totalToolUseCount: 8,
            },
          }
        ),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1)
      const toolCall = asMessage(result[0]).toolCalls[0]
      expect(toolCall.name).toBe('Task')
      expect(toolCall.subagent).toEqual({
        agentId: 'abc123',
        status: 'completed',
        totalDurationMs: 45000,
        totalTokens: 12500,
        totalToolUseCount: 8,
      })
    })

    it('does not extract subagent metadata from non-Task tools', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ]),
        createUserMessage(
          'uuid-2',
          [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file.txt' }],
          '2026-01-24T10:00:02.000Z',
          {
            toolUseResult: {
              stdout: 'file.txt',
              stderr: '',
              interrupted: false,
              isImage: false,
              agentId: 'abc123', // Present but should be ignored for non-Task tools
            },
          }
        ),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).toolCalls[0].subagent).toBeUndefined()
    })

    it('does not extract subagent metadata when toolUseResult has no agentId', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Task', input: { subagent_type: 'Explore' } },
        ]),
        createUserMessage(
          'uuid-2',
          [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }],
          '2026-01-24T10:00:02.000Z',
          {
            toolUseResult: {
              stdout: 'result',
              stderr: '',
              interrupted: false,
              isImage: false,
              // No agentId
            },
          }
        ),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).toolCalls[0].subagent).toBeUndefined()
    })

    it('defaults status to "completed" when not provided', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Task', input: {} },
        ]),
        createUserMessage(
          'uuid-2',
          [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
          '2026-01-24T10:00:02.000Z',
          {
            toolUseResult: {
              stdout: 'done',
              stderr: '',
              interrupted: false,
              isImage: false,
              agentId: 'xyz789',
              // No status field
            },
          }
        ),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).toolCalls[0].subagent).toMatchObject({
        agentId: 'xyz789',
        status: 'completed',
      })
    })

    it('handles Task tool result without toolUseResult (no subagent metadata)', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Task', input: { subagent_type: 'Bash' } },
        ]),
        createUserMessage(
          'uuid-2',
          [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'output' }],
        ),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).toolCalls[0].subagent).toBeUndefined()
      expect(asMessage(result[0]).toolCalls[0].result).toBe('output')
    })

    it('handles subagent metadata with optional stats fields missing', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Task', input: {} },
        ]),
        createUserMessage(
          'uuid-2',
          [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
          '2026-01-24T10:00:02.000Z',
          {
            toolUseResult: {
              stdout: 'done',
              stderr: '',
              interrupted: false,
              isImage: false,
              agentId: 'agent-1',
              status: 'error',
              // No totalDurationMs, totalTokens, totalToolUseCount
            },
          }
        ),
      ]

      const result = transformMessages(entries)

      const subagent = asMessage(result[0]).toolCalls[0].subagent
      expect(subagent).toBeDefined()
      expect(subagent!.agentId).toBe('agent-1')
      expect(subagent!.status).toBe('error')
      expect(subagent!.totalDurationMs).toBeUndefined()
      expect(subagent!.totalTokens).toBeUndefined()
      expect(subagent!.totalToolUseCount).toBeUndefined()
    })

    it('handles multiple tool calls where only Task has subagent metadata', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_use', id: 'tool-2', name: 'Task', input: { subagent_type: 'Explore' } },
        ]),
        createUserMessage('uuid-2', [
          {
            type: 'tool_result', tool_use_id: 'tool-1', content: '/home',
          },
        ]),
        createUserMessage(
          'uuid-3',
          [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'found it' }],
          '2026-01-24T10:00:03.000Z',
          {
            toolUseResult: {
              stdout: 'found it',
              stderr: '',
              interrupted: false,
              isImage: false,
              agentId: 'sub-1',
              status: 'completed',
              totalTokens: 5000,
            },
          }
        ),
      ]

      const result = transformMessages(entries)

      const toolCalls = asMessage(result[0]).toolCalls
      expect(toolCalls).toHaveLength(2)
      expect(toolCalls[0].name).toBe('Bash')
      expect(toolCalls[0].subagent).toBeUndefined()
      expect(toolCalls[1].name).toBe('Task')
      expect(toolCalls[1].subagent).toEqual({
        agentId: 'sub-1',
        status: 'completed',
        totalTokens: 5000,
        totalDurationMs: undefined,
        totalToolUseCount: undefined,
      })
    })
  })

  // ============================================================================
  // transformMessages - Slash Command Transform Tests
  // ============================================================================

  describe('slash command transformation', () => {
    it('transforms skill command with args into /name args', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1',
          '<command-message>clickhouse-query</command-message>\n<command-name>/clickhouse-query</command-name>\n<command-args>how many inference logs today?</command-args>'
        ),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).type).toBe('user')
      expect(asMessage(result[0]).content.text).toBe('/clickhouse-query how many inference logs today?')
    })

    it('transforms local command without args into /name', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1',
          '<command-name>/context</command-name> <command-message>context</command-message> <command-args></command-args>'
        ),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).type).toBe('user')
      expect(asMessage(result[0]).content.text).toBe('/context')
    })

    it('transforms local-command-stdout into assistant message', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1',
          '<local-command-stdout>Context items:\n- file1.ts\n- file2.ts</local-command-stdout>'
        ),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).type).toBe('assistant')
      expect(asMessage(result[0]).content.text).toBe('Context items:\n- file1.ts\n- file2.ts')
    })

    it('does not transform regular user messages', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1', 'Hello world'),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).type).toBe('user')
      expect(asMessage(result[0]).content.text).toBe('Hello world')
    })

    it('transforms command in array content blocks (text block with XML)', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1', [
          { type: 'text', text: '<command-message>clickhouse-query</command-message>\n<command-name>/clickhouse-query</command-name>\n<command-args>SELECT 1</command-args>' },
        ]),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(1)
      expect(asMessage(result[0]).type).toBe('user')
      expect(asMessage(result[0]).content.text).toBe('/clickhouse-query SELECT 1')
    })

    it('does not transform assistant messages containing command-like XML', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'text', text: '<command-name>/context</command-name>' },
        ]),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).type).toBe('assistant')
      expect(asMessage(result[0]).content.text).toBe('<command-name>/context</command-name>')
    })

    it('preserves id and createdAt when flipping command-output to assistant', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-stdout',
          '<local-command-stdout>output</local-command-stdout>',
          '2026-01-24T10:00:05.000Z'
        ),
      ]

      const result = transformMessages(entries)

      expect(result[0].id).toBe('uuid-stdout')
      expect(result[0].createdAt).toEqual(new Date('2026-01-24T10:00:05.000Z'))
    })

    it('does not transform regular user messages starting with slash', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1', '/path/to/some/file'),
      ]

      const result = transformMessages(entries)

      expect(asMessage(result[0]).type).toBe('user')
      expect(asMessage(result[0]).content.text).toBe('/path/to/some/file')
    })

    it('handles full slash command flow: command + stdout + assistant response', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1',
          '<command-name>/context</command-name> <command-message>context</command-message> <command-args></command-args>',
          '2026-01-24T10:00:00.000Z'
        ),
        createUserMessage('uuid-2',
          '<local-command-stdout>Context items:\n- CLAUDE.md</local-command-stdout>',
          '2026-01-24T10:00:01.000Z'
        ),
        createAssistantMessage('uuid-3', 'msg-1',
          [{ type: 'text', text: 'I can see your context items.' }],
          '2026-01-24T10:00:02.000Z'
        ),
      ]

      const result = transformMessages(entries)

      expect(result).toHaveLength(3)
      // Command becomes clean slash command user message
      expect(asMessage(result[0]).type).toBe('user')
      expect(asMessage(result[0]).content.text).toBe('/context')
      // Stdout becomes assistant message
      expect(asMessage(result[1]).type).toBe('assistant')
      expect(asMessage(result[1]).content.text).toBe('Context items:\n- CLAUDE.md')
      // Normal assistant response
      expect(asMessage(result[2]).type).toBe('assistant')
      expect(asMessage(result[2]).content.text).toBe('I can see your context items.')
    })
  })
})

// ============================================================================
// parseCommandMessage Tests
// ============================================================================

describe('parseCommandMessage', () => {
  // --------------------------------------------------------------------------
  // Slash command detection (various tag orderings)
  // --------------------------------------------------------------------------

  describe('slash command detection', () => {
    it('parses command-message first, then command-name, then command-args (skill format)', () => {
      const text = '<command-message>clickhouse-query</command-message>\n<command-name>/clickhouse-query</command-name>\n<command-args>how many inference logs today?</command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'clickhouse-query',
        args: 'how many inference logs today?',
      })
    })

    it('parses command-name first, then command-message, then empty command-args (local command format)', () => {
      const text = '<command-name>/context</command-name> <command-message>context</command-message> <command-args></command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'context',
      })
    })

    it('parses command-name only (minimal format)', () => {
      const text = '<command-name>/compact</command-name>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'compact',
      })
    })

    it('parses command-name without leading slash', () => {
      const text = '<command-name>context</command-name>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'context',
      })
    })

    it('parses command-name + command-args without command-message', () => {
      const text = '<command-name>/query</command-name>\n<command-args>SELECT * FROM users</command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'query',
        args: 'SELECT * FROM users',
      })
    })

    it('parses command-message + command-name without command-args', () => {
      const text = '<command-message>clear</command-message>\n<command-name>/clear</command-name>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'clear',
      })
    })

    it('handles tags separated by spaces', () => {
      const text = '<command-message>foo</command-message> <command-name>/foo</command-name> <command-args>bar</command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'foo',
        args: 'bar',
      })
    })

    it('handles tags separated by newlines', () => {
      const text = '<command-message>foo</command-message>\n<command-name>/foo</command-name>\n<command-args>bar baz</command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'foo',
        args: 'bar baz',
      })
    })

    it('handles tags separated by mixed whitespace', () => {
      const text = '<command-message>test</command-message>\n  \t<command-name>/test</command-name>  \n<command-args>arg</command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'test',
        args: 'arg',
      })
    })
  })

  // --------------------------------------------------------------------------
  // Command output detection
  // --------------------------------------------------------------------------

  describe('command output detection', () => {
    it('parses local-command-stdout with simple content', () => {
      const text = '<local-command-stdout>Hello world</local-command-stdout>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'command-output',
        content: 'Hello world',
      })
    })

    it('parses local-command-stdout with multiline content', () => {
      const text = '<local-command-stdout>Context items:\n- file1.ts\n- file2.ts\n- dir/file3.tsx</local-command-stdout>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'command-output',
        content: 'Context items:\n- file1.ts\n- file2.ts\n- dir/file3.tsx',
      })
    })

    it('parses local-command-stdout with empty content', () => {
      const text = '<local-command-stdout></local-command-stdout>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'command-output',
        content: '',
      })
    })

    it('parses local-command-stdout with special characters', () => {
      const text = '<local-command-stdout>Path: /home/user & "quotes" \'single\' <angle></local-command-stdout>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'command-output',
        content: 'Path: /home/user & "quotes" \'single\' <angle>',
      })
    })

    it('parses local-command-stdout with unicode', () => {
      const text = '<local-command-stdout>Status: OK 🎉 世界</local-command-stdout>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'command-output',
        content: 'Status: OK 🎉 世界',
      })
    })
  })

  // --------------------------------------------------------------------------
  // Args handling
  // --------------------------------------------------------------------------

  describe('args handling', () => {
    it('trims whitespace from args', () => {
      const text = '<command-name>/query</command-name>\n<command-args>  SELECT * FROM users  </command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'query',
        args: 'SELECT * FROM users',
      })
    })

    it('treats whitespace-only args as no args', () => {
      const text = '<command-name>/context</command-name>\n<command-args>   </command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'context',
      })
    })

    it('preserves multiline args', () => {
      const text = '<command-name>/query</command-name>\n<command-args>SELECT *\nFROM users\nWHERE id = 1</command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'query',
        args: 'SELECT *\nFROM users\nWHERE id = 1',
      })
    })

    it('handles args with XML-like content', () => {
      const text = '<command-name>/run</command-name>\n<command-args>echo "<div>hello</div>"</command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'run',
        args: 'echo "<div>hello</div>"',
      })
    })

    it('handles args containing literal </command-args> text', () => {
      // Edge case: args content includes closing tag text
      const text = '<command-name>/echo</command-name>\n<command-args>test </command-args> more</command-args>'
      const result = parseCommandMessage(text)
      // Non-greedy match should capture up to the FIRST </command-args>
      expect(result).toBeNull() // " more" remains after stripping, so it's rejected
    })
  })

  // --------------------------------------------------------------------------
  // Non-matching (should return null)
  // --------------------------------------------------------------------------

  describe('non-matching messages', () => {
    it('returns null for plain text', () => {
      expect(parseCommandMessage('Hello world')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(parseCommandMessage('')).toBeNull()
    })

    it('returns null for whitespace-only string', () => {
      expect(parseCommandMessage('   \n\t  ')).toBeNull()
    })

    it('returns null for partial XML tags', () => {
      expect(parseCommandMessage('<command-name>test')).toBeNull()
    })

    it('returns null for unclosed command-name tag', () => {
      expect(parseCommandMessage('<command-name>test</command-name')).toBeNull()
    })

    it('returns null for text with command-name embedded in other content', () => {
      expect(parseCommandMessage('Please run <command-name>test</command-name> for me')).toBeNull()
    })

    it('returns null for regular HTML/XML-like content', () => {
      expect(parseCommandMessage('<div>Hello</div>')).toBeNull()
    })

    it('returns null for markdown with angle brackets', () => {
      expect(parseCommandMessage('Use `<component>` in your code')).toBeNull()
    })

    it('returns null for text mentioning command-name as literal text', () => {
      expect(parseCommandMessage('The <command-name> tag is used for commands')).toBeNull()
    })

    it('returns null for user message that looks similar but has extra text', () => {
      expect(parseCommandMessage('<command-name>/test</command-name> but also some extra text here')).toBeNull()
    })

    it('returns null for message with only command-message (no command-name)', () => {
      expect(parseCommandMessage('<command-message>test</command-message>')).toBeNull()
    })

    it('returns null for message with only command-args (no command-name)', () => {
      expect(parseCommandMessage('<command-args>some args</command-args>')).toBeNull()
    })
  })

  // --------------------------------------------------------------------------
  // Whitespace / trimming
  // --------------------------------------------------------------------------

  describe('whitespace handling', () => {
    it('trims leading and trailing whitespace from input', () => {
      const text = '  \n<command-name>/test</command-name>\n  '
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'test',
      })
    })

    it('trims leading/trailing whitespace from local-command-stdout', () => {
      const text = '  <local-command-stdout>output</local-command-stdout>  '
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'command-output',
        content: 'output',
      })
    })
  })

  // --------------------------------------------------------------------------
  // Real-world JSONL content (exact strings from production)
  // --------------------------------------------------------------------------

  describe('real-world JSONL content', () => {
    it('parses actual /clickhouse-query JSONL content', () => {
      // Exact content from production JSONL
      const text = '<command-message>clickhouse-query</command-message>\n<command-name>/clickhouse-query</command-name>\n<command-args>how many inference logs today?</command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'clickhouse-query',
        args: 'how many inference logs today?',
      })
    })

    it('parses actual /context JSONL content', () => {
      // Exact content from production JSONL
      const text = '<command-name>/context</command-name> <command-message>context</command-message> <command-args></command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'context',
      })
    })

    it('parses actual /context stdout JSONL content', () => {
      const text = '<local-command-stdout>Context items:\n\n /workspace/CLAUDE.md (user)\n\nNote: To manage context, use the /context command.\n\nAvailable flags:\n  /context --add <path>: Manually add a file or directory\n  /context --remove <path>: Remove a specific context item</local-command-stdout>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'command-output',
        content: 'Context items:\n\n /workspace/CLAUDE.md (user)\n\nNote: To manage context, use the /context command.\n\nAvailable flags:\n  /context --add <path>: Manually add a file or directory\n  /context --remove <path>: Remove a specific context item',
      })
    })

    it('parses /compact command format', () => {
      const text = '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'
      const result = parseCommandMessage(text)
      expect(result).toEqual({
        type: 'slash-command',
        name: 'compact',
      })
    })
  })
})
