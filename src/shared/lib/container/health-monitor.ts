import type { ContainerStats, HealthCheckResult } from './types'

/**
 * A pluggable health checker that evaluates container stats and produces a result.
 */
export interface HealthChecker {
  name: string
  check(agentId: string, stats: ContainerStats): HealthCheckResult
}

/**
 * Memory health checker - warns when container memory usage is high.
 */
const memoryHealthChecker: HealthChecker = {
  name: 'memory',
  check(_agentId, stats) {
    if (stats.memoryPercent >= 95) {
      return {
        checkName: 'memory',
        status: 'critical',
        message: `Memory usage is critically high (${stats.memoryPercent.toFixed(0)}%). The container may become unresponsive. Consider increasing the memory limit in settings.`,
        details: {
          memoryPercent: stats.memoryPercent,
          memoryUsageBytes: stats.memoryUsageBytes,
          memoryLimitBytes: stats.memoryLimitBytes,
        },
      }
    }
    if (stats.memoryPercent >= 85) {
      return {
        checkName: 'memory',
        status: 'warning',
        message: `Memory usage is high (${stats.memoryPercent.toFixed(0)}%). Consider increasing the memory limit in settings.`,
        details: {
          memoryPercent: stats.memoryPercent,
          memoryUsageBytes: stats.memoryUsageBytes,
          memoryLimitBytes: stats.memoryLimitBytes,
        },
      }
    }
    return { checkName: 'memory', status: 'ok' }
  },
}

/**
 * Registry of health checkers. Run all checks against container stats.
 */
class HealthMonitor {
  private checkers: HealthChecker[] = []

  registerChecker(checker: HealthChecker): void {
    this.checkers.push(checker)
  }

  /**
   * Run all registered health checks against the given stats.
   * Returns only non-ok results (warnings and critical).
   */
  checkAll(agentId: string, stats: ContainerStats): HealthCheckResult[] {
    const results: HealthCheckResult[] = []
    for (const checker of this.checkers) {
      const result = checker.check(agentId, stats)
      if (result.status !== 'ok') {
        results.push(result)
      }
    }
    return results
  }
}

// Export singleton with memory checker pre-registered
export const healthMonitor = new HealthMonitor()
healthMonitor.registerChecker(memoryHealthChecker)
