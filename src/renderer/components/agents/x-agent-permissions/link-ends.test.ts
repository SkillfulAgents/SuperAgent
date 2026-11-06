import { describe, expect, it } from 'vitest'
import { endClick, lineWords, linkEnd, menuWrite, middleClick, showsEnd } from './link-ends'

describe('linkEnd', () => {
  it('reads only what is saved for the pair', () => {
    expect(linkEnd('allow')).toBe('allowed')
    expect(linkEnd('block')).toBe('blocked')
    expect(linkEnd('default')).toBe('ask')
    expect(linkEnd('review')).toBe('ask')
  })
})

describe('lineWords', () => {
  it('names who does what for each mix of directions', () => {
    expect(lineWords('message', { out: 'allowed', in: 'allowed' }, 'Work')).toBe('can message each other')
    expect(lineWords('message', { out: 'allowed', in: 'ask' }, 'Work', 'Analytics Tzar')).toBe('Work can message Analytics Tzar')
    expect(lineWords('read', { out: 'blocked', in: 'allowed' }, 'Work', 'Analytics Tzar')).toBe('Analytics Tzar can read Work’s chats')
    expect(lineWords('read', { out: 'allowed', in: 'ask' }, 'Work', 'my agents')).toBe('Work can read my agents’ chats')
    expect(lineWords('message', { out: 'ask', in: 'ask' }, 'Work')).toBe('messages · asks first')
  })

  it('never says "asks first" for a direction that is blocked', () => {
    expect(lineWords('message', { out: 'blocked', in: 'ask' }, 'Work')).toBe('Work can’t message the agent')
    expect(lineWords('read', { out: 'ask', in: 'blocked' }, 'Work')).toBe('the agent can’t read Work’s chats')
    expect(lineWords('message', { out: 'blocked', in: 'blocked' }, 'Work')).toBe('messages · blocked')
  })

})

describe('middleClick', () => {
  it('turns on only the direction this agent starts, so the reverse grant is always its own click', () => {
    expect(middleClick({ out: 'ask', in: 'ask' }, 'out')).toEqual([{ direction: 'out', write: 'allow' }])
  })

  it('turns off every end that is on, one way or both, and a second click undoes it', () => {
    expect(middleClick({ out: 'allowed', in: 'allowed' }, 'out')).toEqual([{ direction: 'out', write: 'clear' }, { direction: 'in', write: 'clear' }])
    expect(middleClick({ out: 'ask', in: 'allowed' }, 'out')).toEqual([{ direction: 'in', write: 'clear' }])
  })

  it('never lifts a Block, and goes to the other end when this agent’s end is blocked', () => {
    expect(middleClick({ out: 'blocked', in: 'ask' }, 'out')).toEqual([{ direction: 'in', write: 'allow' }])
    expect(middleClick({ out: 'blocked', in: 'blocked' }, 'out')).toEqual([])
    expect(endClick('blocked')).toBeNull()
  })
})

describe('showsEnd', () => {
  it('hides the reverse end while the line is off, and shows it once the line is on or something is saved', () => {
    expect(showsEnd({ out: 'ask', in: 'ask' }, 'in', 'out')).toBe(false)
    expect(showsEnd({ out: 'allowed', in: 'ask' }, 'in', 'out')).toBe(true)
    expect(showsEnd({ out: 'ask', in: 'blocked' }, 'in', 'out')).toBe(true)
  })
})

describe('menuWrite', () => {
  it('blocks and unblocks only from the menu', () => {
    expect(menuWrite('block')).toBe('block')
    expect(menuWrite('ask')).toBe('clear')
  })
})
