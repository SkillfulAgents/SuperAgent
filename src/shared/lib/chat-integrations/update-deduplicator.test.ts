import { describe, it, expect } from 'vitest'
import { UpdateDeduplicator } from './update-deduplicator'

describe('UpdateDeduplicator', () => {
  it('treats a never-delivered id as not a duplicate', () => {
    const dedup = new UpdateDeduplicator(10)
    expect(dedup.isDuplicate('5001')).toBe(false)
  })

  it('isDuplicate is read-only: checking an id never records it', () => {
    const dedup = new UpdateDeduplicator(10)
    expect(dedup.isDuplicate('5001')).toBe(false)
    // A message accepted but not yet handed off must stay eligible for redelivery, so a check
    // alone can never make the next check report a duplicate.
    expect(dedup.isDuplicate('5001')).toBe(false)
  })

  it('reports a duplicate only after the id is marked delivered', () => {
    const dedup = new UpdateDeduplicator(10)
    dedup.markDelivered('5001')
    expect(dedup.isDuplicate('5001')).toBe(true)
  })

  it('markDelivered is idempotent', () => {
    const dedup = new UpdateDeduplicator(10)
    dedup.markDelivered('5001')
    dedup.markDelivered('5001')
    expect(dedup.isDuplicate('5001')).toBe(true)
  })

  it('tracks distinct ids independently', () => {
    const dedup = new UpdateDeduplicator(10)
    dedup.markDelivered('5001')
    expect(dedup.isDuplicate('5001')).toBe(true)
    expect(dedup.isDuplicate('5002')).toBe(false)
  })

  it('evicts the oldest delivered id once capacity is exceeded (bounded by count, not time)', () => {
    const dedup = new UpdateDeduplicator(2)
    dedup.markDelivered('1')
    dedup.markDelivered('2')
    dedup.markDelivered('3') // exceeds capacity → evicts oldest (1)
    // 1 was evicted, so it reads as new again
    expect(dedup.isDuplicate('1')).toBe(false)
    // 3 is still remembered
    expect(dedup.isDuplicate('3')).toBe(true)
  })
})
