import { describe, expect, it } from 'vitest'
import { landingTop, nextLocateStep } from './locate-message'

const base = { rendered: false, loaded: false, hasOlder: true, isFetchingOlder: false }

describe('nextLocateStep', () => {
  it('places a rendered message, and grows the window to a loaded one', () => {
    expect(nextLocateStep({ ...base, loaded: true, rendered: true })).toBe('place')
    expect(nextLocateStep({ ...base, loaded: true })).toBe('grow')
  })

  it('pages back while older history is left, one page at a time, then stops', () => {
    expect(nextLocateStep({ ...base, isFetchingOlder: true })).toBe('wait')
    expect(nextLocateStep({ ...base, hasOlder: false })).toBe('stop')
  })
})

describe('landingTop', () => {
  it('centers a row that fits, and puts a taller row at the top', () => {
    expect(landingTop(1000, 100, 500)).toBe(800)
    expect(landingTop(1000, 800, 500)).toBe(1000)
    expect(landingTop(50, 100, 500)).toBe(0)
  })
})
