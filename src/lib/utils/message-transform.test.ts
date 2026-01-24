import { describe, it, expect } from 'vitest'
import {
  transformMessages,
  isToolResultOnlyMessage,
} from './message-transform'
import { JsonlMessageEntry, ContentBlock } from '@/lib/types/agent'

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

      expect(result[0].content.text).toBe('First Second')
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
      expect(result[0].content.text).toBe('First')
      expect(result[1].content.text).toBe('Second')
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
      expect(result[0].content.text).toBe('Starting. Done!')
      expect(result[0].toolCalls).toHaveLength(1)
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
      expect(result[0].toolCalls[0].result).toBe('hello')
      expect(result[0].toolCalls[0].isError).toBe(false)
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

      expect(result[0].toolCalls[0].result).toBe('command not found')
      expect(result[0].toolCalls[0].isError).toBe(true)
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
      expect(result[0].toolCalls[0].result).toBe('')
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

      expect(result[0].toolCalls[0].result).toBe('file1\nfile2\nfile3')
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

      expect(result[0].toolCalls).toHaveLength(2)
      expect(result[0].toolCalls[0].result).toBe('/home/user')
      expect(result[0].toolCalls[1].result).toBe('user')
    })

    it('handles tool call without result yet (pending)', () => {
      const entries: JsonlMessageEntry[] = [
        createAssistantMessage('uuid-1', 'msg-1', [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 10' } },
        ]),
        // No tool result entry yet
      ]

      const result = transformMessages(entries)

      expect(result[0].toolCalls[0].result).toBeUndefined()
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
      expect(result[0].content.text).toBe('Here is the result:')
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
      expect(result[1].toolCalls).toHaveLength(1)
      expect(result[1].toolCalls[0].name).toBe('mcp__user-input__request_connected_account')
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
      expect(result[1].toolCalls[0].result).toBe('file1.txt\nfile2.txt')
      expect(result[1].toolCalls[1].result).toBe('/home/user')
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
      expect(result[0].content.text).toBe('Hello')
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
      expect(result[0].content.text).toBe('Here is my answer.')
      expect(result[0].toolCalls).toHaveLength(0)
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
      expect(result[0].toolCalls).toHaveLength(0)
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
      expect(result[0].toolCalls[0].result).toBe('result')
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

      expect(result[0].content.text).toBe('Plain string content')
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
      expect(result[0].toolCalls[0].result).toBe('second result')
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
      expect(result[0].content.text).toBe('')
      expect(result[0].toolCalls).toHaveLength(0)
    })

    it('handles unicode and special characters in text', () => {
      const entries: JsonlMessageEntry[] = [
        createUserMessage('uuid-1', 'Hello 👋 世界 \n\t "quotes" & <tags>'),
        createAssistantMessage('uuid-2', 'msg-1', [
          { type: 'text', text: 'Response: émojis 🎉 and spëcial çhars' },
        ]),
      ]

      const result = transformMessages(entries)

      expect(result[0].content.text).toBe('Hello 👋 世界 \n\t "quotes" & <tags>')
      expect(result[1].content.text).toBe('Response: émojis 🎉 and spëcial çhars')
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

      expect(result[0].toolCalls[0].input).toEqual(complexInput)
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
      expect(result[0].content.text).toBe('A1 A2')
      expect(result[1].content.text).toBe('B1 B2')
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
      expect(result[1].content.text).toBe('Part 1 Part 2')
    })
  })
})
