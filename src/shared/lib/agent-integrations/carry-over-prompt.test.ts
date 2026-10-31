import { describe, expect, it } from 'vitest'
import { carryOverPrompt } from './carry-over-prompt'

describe('carryOverPrompt', () => {
  it('is null when there is nothing to carry', () => {
    expect(carryOverPrompt({ summary: null, recent: [] })).toBeNull()
  })

  it('puts the summary before the last messages', () => {
    expect(carryOverPrompt({
      summary: 'The dentist is booked for Tuesday at 9 AM.',
      recent: [
        { role: 'user', text: 'Who is the advocate on the Ellis file?' },
        { role: 'assistant', text: 'Olga Garnica is the advocate.' },
      ],
    })).toBe([
      '<previous_conversation>',
      'This chat continues an earlier conversation with the same person. Use it as background for the new message.',
      '<summary>',
      'The dentist is booked for Tuesday at 9 AM.',
      '</summary>',
      '<last_messages>',
      'User: Who is the advocate on the Ellis file?',
      'You: Olga Garnica is the advocate.',
      '</last_messages>',
      '</previous_conversation>',
    ].join('\n'))
  })
})
