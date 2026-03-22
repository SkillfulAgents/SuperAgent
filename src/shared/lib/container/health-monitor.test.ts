import { describe, it, expect } from 'vitest'
import type { ContainerStats } from './types'
import type { HealthChecker } from './health-monitor'

// Import the singleton to test it, and re-create fresh instances for isolation
// We import the module to access the exported singleton and the class shape
import { healthMonitor } from './health-monitor'

function makeStats(overrides: Partial<ContainerStats> = {}): ContainerStats {
  return {
    memoryUsageBytes: 500_000_000,
    memoryLimitBytes: 1_000_000_000,
    memoryPercent: 50,
    cpuPercent: 10,
    ...overrides,
  }
}

describe('memory health checker (via singleton)', () => {
  it('returns no warnings for normal memory usage', () => {
    const results = healthMonitor.checkAll('agent-1', makeStats({ memoryPercent: 50 }))
    expect(results).toEqual([])
  })

  it('returns no warnings at 84%', () => {
    const results = healthMonitor.checkAll('agent-1', makeStats({ memoryPercent: 84 }))
    expect(results).toEqual([])
  })

  it('returns warning at 85%', () => {
    const results = healthMonitor.checkAll('agent-1', makeStats({ memoryPercent: 85 }))
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('warning')
    expect(results[0].checkName).toBe('memory')
    expect(results[0].message).toContain('high')
    expect(results[0].message).toContain('85%')
  })

  it('returns warning at 90%', () => {
    const results = healthMonitor.checkAll('agent-1', makeStats({ memoryPercent: 90 }))
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('warning')
  })

  it('returns warning at 94%', () => {
    const results = healthMonitor.checkAll('agent-1', makeStats({ memoryPercent: 94 }))
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('warning')
  })

  it('returns critical at 95%', () => {
    const results = healthMonitor.checkAll('agent-1', makeStats({ memoryPercent: 95 }))
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('critical')
    expect(results[0].checkName).toBe('memory')
    expect(results[0].message).toContain('critically high')
    expect(results[0].message).toContain('95%')
  })

  it('returns critical at 100%', () => {
    const results = healthMonitor.checkAll('agent-1', makeStats({ memoryPercent: 100 }))
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('critical')
  })

  it('includes memory details in warning', () => {
    const stats = makeStats({
      memoryPercent: 90,
      memoryUsageBytes: 900_000_000,
      memoryLimitBytes: 1_000_000_000,
    })
    const results = healthMonitor.checkAll('agent-1', stats)
    expect(results[0].details).toEqual({
      memoryPercent: 90,
      memoryUsageBytes: 900_000_000,
      memoryLimitBytes: 1_000_000_000,
    })
  })

  it('includes memory details in critical', () => {
    const stats = makeStats({
      memoryPercent: 98,
      memoryUsageBytes: 980_000_000,
      memoryLimitBytes: 1_000_000_000,
    })
    const results = healthMonitor.checkAll('agent-1', stats)
    expect(results[0].details).toEqual({
      memoryPercent: 98,
      memoryUsageBytes: 980_000_000,
      memoryLimitBytes: 1_000_000_000,
    })
  })

  it('formats memoryPercent without decimals in message', () => {
    const results = healthMonitor.checkAll(
      'agent-1',
      makeStats({ memoryPercent: 87.654 })
    )
    expect(results[0].message).toContain('88%')
    expect(results[0].message).not.toContain('87.654')
  })
})

describe('HealthMonitor.checkAll filtering', () => {
  it('only returns non-ok results', () => {
    // The singleton has the memory checker; at 50% memory it returns ok
    const results = healthMonitor.checkAll('agent-1', makeStats({ memoryPercent: 50 }))
    expect(results).toEqual([])
  })

  it('returns results from all checkers that fire', () => {
    // With the default memory checker at 95%, we get one critical result
    const results = healthMonitor.checkAll('agent-1', makeStats({ memoryPercent: 96 }))
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.every((r) => r.status !== 'ok')).toBe(true)
  })
})

describe('HealthMonitor.registerChecker', () => {
  it('custom checker results are included in checkAll', () => {
    // Register a custom checker on the singleton
    const customChecker: HealthChecker = {
      name: 'cpu',
      check(_agentId, stats) {
        if (stats.cpuPercent >= 90) {
          return {
            checkName: 'cpu',
            status: 'warning',
            message: `CPU usage is high (${stats.cpuPercent}%)`,
          }
        }
        return { checkName: 'cpu', status: 'ok' }
      },
    }

    healthMonitor.registerChecker(customChecker)

    // High CPU, low memory → only CPU warning
    const results = healthMonitor.checkAll(
      'agent-1',
      makeStats({ memoryPercent: 50, cpuPercent: 95 })
    )
    const cpuResult = results.find((r) => r.checkName === 'cpu')
    expect(cpuResult).toBeDefined()
    expect(cpuResult!.status).toBe('warning')
  })
})
