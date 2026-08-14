/**
 * Pin the measured delivery sentences. Shortening automation orientation to
 * an origin label alone measures 6/10; the delivery fact does the work.
 */

import { describe, it, expect } from 'vitest'
import { buildSessionContextPrompt } from './session-context'

describe('buildSessionContextPrompt', () => {
  it('pins the measured app delivery sentence', () => {
    expect(buildSessionContextPrompt({ surface: 'app' })).toBe(
      'This session is a conversation in the app. Your response is delivered into it — writing it is what sends it, and no tool is needed for that.',
    )
  })

  it.each([
    {
      kind: 'scheduled-task' as const,
      origin: 'a scheduled task',
    },
    {
      kind: 'webhook-trigger' as const,
      origin: 'a webhook trigger',
    },
  ])('pins the measured $kind delivery sentence', ({ kind, origin }) => {
    expect(
      buildSessionContextPrompt({
        surface: 'automation',
        kind,
      }),
    ).toBe(
      `This session was started by ${origin}, not by a person in a conversation. Your response goes to the session transcript, and writing it does not reach anyone. If you need to tell a person or agent something, that takes a tool.`,
    )
  })

  it('pins the measured asynchronous agent-call delivery sentence', () => {
    expect(
      buildSessionContextPrompt({
        surface: 'agent-call',
      }),
    ).toBe(
      'This session was started by another agent. Your response is recorded in this session\'s transcript. Writing it is what records it, and no tool is needed. Put the answer in your final message rather than in interim narration.',
    )
  })
})
