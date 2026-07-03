import { describe, it, expect } from 'vitest'
import { UpdateDeduplicator } from './update-deduplicator'

describe('UpdateDeduplicator', () => {
  it('treats a never-seen id as not a duplicate', () => {
    const dedup = new UpdateDeduplicator(10)
    expect(dedup.isDuplicate('5001')).toBe(false)
  })

  it('treats a repeated id as a duplicate', () => {
    const dedup = new UpdateDeduplicator(10)
    dedup.isDuplicate('5001')
    expect(dedup.isDuplicate('5001')).toBe(true)
  })

  it('tracks distinct ids independently', () => {
    const dedup = new UpdateDeduplicator(10)
    expect(dedup.isDuplicate('5001')).toBe(false)
    expect(dedup.isDuplicate('5002')).toBe(false)
    expect(dedup.isDuplicate('5001')).toBe(true)
    expect(dedup.isDuplicate('5002')).toBe(true)
  })

  it('evicts the oldest id once capacity is exceeded (bounded by count, not time)', () => {
    const dedup = new UpdateDeduplicator(2)
    dedup.isDuplicate('1') // record 1
    dedup.isDuplicate('2') // record 2
    dedup.isDuplicate('3') // record 3 → evicts oldest (1)
    // 1 was evicted, so it reads as new again
    expect(dedup.isDuplicate('1')).toBe(false)
    // 3 is still remembered
    expect(dedup.isDuplicate('3')).toBe(true)
  })
})
