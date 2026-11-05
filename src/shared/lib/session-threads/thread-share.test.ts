import { describe, it, expect } from 'vitest'
import { formatThreadForAgent, joinNames } from './thread-share'
import { parseUserMessageParts } from '@shared/lib/utils/user-message-parts'

describe('joinNames', () => {
  it('reads as a sentence', () => {
    expect(joinNames(['West'])).toBe('West')
    expect(joinNames(['West', 'Graham'])).toBe('West and Graham')
    expect(joinNames(['West', 'Graham', 'Iddo'])).toBe('West, Graham and Iddo')
  })
})

describe('formatThreadForAgent', () => {
  it('opens with who was talking, then gives the parent and each reply under its author', () => {
    const text = formatThreadForAgent(
      { name: 'West', text: '@Graham can you look at the deploy?' },
      [{ name: 'Graham', text: 'On it.\n\nLooks like a timeout.' }, { name: 'West', text: 'Thanks' }],
    )
    expect(text).toBe([
      'West and Graham were side-chatting in a thread in this session and want to loop you in. Here is the thread:',
      '',
      '**West** (the message the thread is on):\n@Graham can you look at the deploy?',
      '',
      '**Graham:**\nOn it.\n\nLooks like a timeout.',
      '',
      '**West:**\nThanks',
    ].join('\n'))
  })

  it('uses no > quotes, so Enter in the composer sends it rather than continuing a quote', () => {
    const text = formatThreadForAgent({ name: 'West', text: 'hi' }, [{ name: 'Graham', text: 'hello' }])
    expect(text.split('\n').some((line) => line.startsWith('>'))).toBe(false)
  })

  it('is an ordinary message: it does not open on a teammate, so the agent runs', () => {
    const text = formatThreadForAgent({ name: 'West', text: 'hi' }, [{ name: 'West', text: 'me again' }])
    expect(text.startsWith('West was side-chatting')).toBe(true)
    expect(parseUserMessageParts(text).silent).toBe(false)
  })

  it('names the files a message or reply was sent with, so the agent can open them', () => {
    const text = formatThreadForAgent(
      { name: 'West', text: 'see the deck', files: ['uploads/deck.pdf'] },
      [{ name: 'Graham', text: '', files: ['uploads/a.png', 'uploads/b.png'] }],
    )
    expect(text).toContain(['see the deck', 'Attached: `uploads/deck.pdf`'].join('\n'))
    expect(text).toContain(['**Graham:**', 'Attached: `uploads/a.png`', 'Attached: `uploads/b.png`'].join('\n'))
  })
})
