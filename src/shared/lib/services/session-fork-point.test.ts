import { describe, expect, it } from 'vitest'
import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'
import { forkPointAfter } from './session-fork-point'

function user(uuid: string, content: JsonlMessageEntry['message']['content'], extra: Partial<JsonlMessageEntry> = {}): JsonlMessageEntry {
  return { uuid, parentUuid: null, type: 'user', sessionId: 's', timestamp: '', message: { role: 'user', content }, ...extra }
}
function assistant(uuid: string): JsonlMessageEntry {
  return { uuid, parentUuid: null, type: 'assistant', sessionId: 's', timestamp: '', message: { role: 'assistant', content: 'ok' } }
}
function system(uuid: string): JsonlSystemEntry {
  return { uuid, type: 'system', subtype: 'informational', content: '', isMeta: false, timestamp: '' }
}

const toolResult = [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] as JsonlMessageEntry['message']['content']

describe('forkPointAfter', () => {
  const transcript = [
    user('u1', 'Draft the plan'),
    assistant('a1'),
    user('r1', toolResult),
    assistant('a2'),
    system('s1'),
    user('u2', 'Now the email'),
    assistant('a3'),
  ]

  it('ends after the whole reply: tool results and system lines included, up to the next message sent', () => {
    expect(forkPointAfter(transcript, 'u1')).toBe('s1')
  })

  it('runs to the end of the transcript for the last message', () => {
    expect(forkPointAfter(transcript, 'u2')).toBe('a3')
  })

  it('is the message itself when nothing followed it', () => {
    expect(forkPointAfter([user('u1', 'hi')], 'u1')).toBe('u1')
  })

  it('does not stop at SDK notes or compaction summaries', () => {
    const entries = [
      user('u1', 'hi'),
      assistant('a1'),
      user('m1', 'context', { isCompactSummary: true }),
      user('n1', 'note', { origin: { kind: 'task-notification' } }),
      assistant('a2'),
      user('u2', 'next'),
    ]
    expect(forkPointAfter(entries, 'u1')).toBe('a2')
  })

  it('is null for a message the transcript does not have', () => {
    expect(forkPointAfter(transcript, 'missing')).toBeNull()
  })
})
