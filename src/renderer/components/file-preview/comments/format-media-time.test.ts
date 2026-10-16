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
    expect(formatMediaTime(12.999999999)).toBe('0:12')
  })

  it('adds floored hundredths for comments', () => {
    expect(formatMediaTime(201.4, { hundredths: true })).toBe('3:21.40')
    expect(formatMediaTime(0.29, { hundredths: true })).toBe('0:00.29')
    expect(formatMediaTime(12.999999999, { hundredths: true })).toBe('0:12.99')
    expect(formatMediaTime(131072.02, { hundredths: true })).toBe('36:24:32.02')
    expect(formatMediaTime(3723.05, { hundredths: true })).toBe('1:02:03.05')
  })

  it('collapses negative or non-finite input to zero', () => {
    expect(formatMediaTime(-4)).toBe('0:00')
    expect(formatMediaTime(NaN)).toBe('0:00')
    expect(formatMediaTime(Infinity)).toBe('0:00')
    expect(formatMediaTime(NaN, { hundredths: true })).toBe('0:00.00')
  })
})
