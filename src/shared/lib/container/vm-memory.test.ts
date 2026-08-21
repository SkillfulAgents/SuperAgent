import { describe, it, expect } from 'vitest'
import { parseVmMemoryBytes, assessVmMemory } from './vm-memory'

const GiB = 1024 ** 3

describe('parseVmMemoryBytes', () => {
  it('parses whole GiB values', () => {
    expect(parseVmMemoryBytes('4GiB')).toBe(4 * GiB)
    expect(parseVmMemoryBytes('16GiB')).toBe(16 * GiB)
  })

  it('parses fractional GiB values', () => {
    expect(parseVmMemoryBytes('1.5GiB')).toBe(1.5 * GiB)
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseVmMemoryBytes(' 8GiB ')).toBe(8 * GiB)
  })

  it('returns null for other units and malformed strings', () => {
    expect(parseVmMemoryBytes('4GB')).toBeNull()
    expect(parseVmMemoryBytes('4g')).toBeNull()
    expect(parseVmMemoryBytes('GiB')).toBeNull()
    expect(parseVmMemoryBytes('')).toBeNull()
    expect(parseVmMemoryBytes('4GiB extra')).toBeNull()
  })
})

describe('assessVmMemory', () => {
  const HOST_16GB = 16 * GiB

  it('refuses a size equal to host total memory', () => {
    const result = assessVmMemory('16GiB', HOST_16GB)
    expect(result.level).toBe('refuse')
    expect(result.level === 'refuse' && result.message).toContain('16 GB')
    expect(result.level === 'refuse' && result.message).toContain('total memory')
  })

  it('refuses a size above host total memory', () => {
    expect(assessVmMemory('16GiB', 8 * GiB).level).toBe('refuse')
  })

  it('warns above half of host total memory (the Jessica case: 12GiB on a 16GB Mac)', () => {
    const result = assessVmMemory('12GiB', HOST_16GB)
    expect(result.level).toBe('warn')
    expect(result.level === 'warn' && result.message).toContain('more than half')
  })

  it('does not warn at exactly half of host total memory', () => {
    expect(assessVmMemory('8GiB', HOST_16GB).level).toBe('ok')
  })

  it('is ok below half of host total memory', () => {
    expect(assessVmMemory('4GiB', HOST_16GB).level).toBe('ok')
    expect(assessVmMemory('2GiB', HOST_16GB).level).toBe('ok')
  })

  it('assesses unparseable values as ok (shape is the allowlist gate, not this one)', () => {
    expect(assessVmMemory('not-a-size', HOST_16GB).level).toBe('ok')
  })

  it('assesses as ok when host memory is unknown or nonsensical', () => {
    expect(assessVmMemory('16GiB', 0).level).toBe('ok')
    expect(assessVmMemory('16GiB', -1).level).toBe('ok')
    expect(assessVmMemory('16GiB', NaN).level).toBe('ok')
  })

  it('formats fractional host totals with one decimal', () => {
    const result = assessVmMemory('12GiB', 13.5 * GiB)
    expect(result.level).toBe('warn')
    expect(result.level === 'warn' && result.message).toContain('13.5 GB')
  })
})
