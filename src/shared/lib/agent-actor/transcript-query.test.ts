import { describe, expect, it } from 'vitest'
import type { JsonlMessageEntry } from '@shared/lib/types/agent'
import { matchesTranscriptQuery } from './transcript-query'

const entry = (fields: Record<string, unknown>) => fields as unknown as JsonlMessageEntry

const person = entry({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Summarize the report' } })
const toolResult = entry({
  type: 'user', uuid: 'u2',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
})
const reply = entry({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } })

describe('matchesTranscriptQuery', () => {
  it('finds the user message sent with a uuid', () => {
    const matches = matchesTranscriptQuery({ kind: 'user', uuid: 'u1' })
    expect([person, toolResult, reply].filter(matches)).toEqual([person])
  })

  it('finds assistant messages', () => {
    expect([person, toolResult, reply].filter(matchesTranscriptQuery({ kind: 'assistant' }))).toEqual([reply])
  })

  it('finds what a person wrote, not tool results', () => {
    expect([person, toolResult, reply].filter(matchesTranscriptQuery({ kind: 'user-request' }))).toEqual([person])
  })
})
