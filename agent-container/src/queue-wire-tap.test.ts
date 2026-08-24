import { describe, expect, it } from 'vitest'
import { STEER_WRAPPER, inspectMessagesBody } from './queue-wire-tap'

const queued = ['and datawizz']

describe('inspectMessagesBody', () => {
  it('flags a steer wrapper plus the queued text', () => {
    const raw = JSON.stringify({
      system: [{ type: 'text', text: `${STEER_WRAPPER}\nand datawizz` }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'can you search for ongamut.so ?' }] }],
    })
    expect(inspectMessagesBody(raw, queued)).toEqual({
      hasSteerWrapper: true,
      queuedHits: ['and datawizz'],
      userTextPreviews: ['can you search for ongamut.so ?'],
    })
  })

  it('reports a miss when the body only has the original prompt', () => {
    const raw = JSON.stringify({
      system: [{ type: 'text', text: 'You are a coding assistant.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'can you search for ongamut.so ?' }] }],
    })
    expect(inspectMessagesBody(raw, queued)).toEqual({
      hasSteerWrapper: false,
      queuedHits: [],
      userTextPreviews: ['can you search for ongamut.so ?'],
    })
  })

  it('finds queued text even without the wrapper', () => {
    const raw = JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'and datawizz' }] }],
    })
    expect(inspectMessagesBody(raw, queued)).toMatchObject({
      hasSteerWrapper: false,
      queuedHits: ['and datawizz'],
    })
  })

  it('does not throw on malformed JSON', () => {
    expect(inspectMessagesBody('not-json and datawizz', queued)).toEqual({
      hasSteerWrapper: false,
      queuedHits: ['and datawizz'],
      userTextPreviews: [],
    })
  })
})
