import { describe, expect, it } from 'vitest'
import { CLEAR_PRESENTATIONAL_ROLE_SCRIPT, PRESENTATIONAL_FRAME_SELECTOR } from './presentational-frames'

function frame(role: string) {
  const attrs: Record<string, string> = { role, title: 'Sign in' }
  return { attrs, removeAttribute: (name: string) => { delete attrs[name] } }
}

const run = (document: unknown) => new Function('document', `return ${CLEAR_PRESENTATIONAL_ROLE_SCRIPT}`)(document) as number

describe('CLEAR_PRESENTATIONAL_ROLE_SCRIPT', () => {
  it('drops the role, and only the role, from every frame the selector finds', () => {
    const frames = [frame('none'), frame('presentation')]
    const queried: string[] = []
    const changed = run({ querySelectorAll: (q: string) => { queried.push(q); return frames } })
    expect(queried).toEqual([PRESENTATIONAL_FRAME_SELECTOR])
    expect(changed).toBe(2)
    expect(frames.map((f) => f.attrs)).toEqual([{ title: 'Sign in' }, { title: 'Sign in' }])
  })

  it('answers 0 when the page cannot be read', () => {
    expect(run({ querySelectorAll: () => { throw new Error('detached') } })).toBe(0)
  })
})
