import { describe, it, expect } from 'vitest'
import { formatMediaTime } from './format-media-time'

describe('formatMediaTime', () => {
  it('formats sub-minute times as m:ss', () => {
    expect(formatMediaTime(0)).toBe('0:00')
    expect(formatMediaTime(5)).toBe('0:05')
    expect(formatMediaTime(59)).toBe('0:59')
  })

  it('formats minutes with zero-padded seconds', () => {
    expect(formatMediaTime(60)).toBe('1:00')
    expect(formatMediaTime(75)).toBe('1:15')
    expect(formatMediaTime(629)).toBe('10:29')
  })

  it('adds an hours field past an hour', () => {
    expect(formatMediaTime(3600)).toBe('1:00:00')
    expect(formatMediaTime(3661)).toBe('1:01:01')
  })

  it('floors fractional seconds', () => {
    expect(formatMediaTime(12.9)).toBe('0:12')
  })

  it('collapses negative or non-finite input to 0:00', () => {
    expect(formatMediaTime(-4)).toBe('0:00')
    expect(formatMediaTime(NaN)).toBe('0:00')
    expect(formatMediaTime(Infinity)).toBe('0:00')
  })
})
