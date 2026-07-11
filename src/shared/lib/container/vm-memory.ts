/**
 * Guardrails for the built-in runtime's VM memory setting.
 *
 * A VM sized at or beyond the machine's physical RAM starves the host, and the
 * guest OOM killer then SIGKILLs the agent process mid-turn — sessions appear
 * to just stop for no reason. Sizes are refused when they cannot coexist with
 * the host and flagged when they squeeze it.
 *
 * Host total memory is passed in (not read from `os`) so this module stays
 * importable from the renderer, which gets the value from the settings API.
 */

export type VmMemoryAssessment =
  | { level: 'ok' }
  | { level: 'warn'; message: string }
  | { level: 'refuse'; message: string }

/** Parse a Lima-style memory string ('12GiB') into bytes. Null for anything else. */
export function parseVmMemoryBytes(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)GiB$/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 1024 ** 3
}

function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
}

/**
 * Assess a requested VM memory size against the host's total memory:
 * refuse at >= total, warn above half. Unparseable values and unknown host
 * memory assess as ok — the options allowlist is the shape gate, this is
 * only the sizing gate.
 */
export function assessVmMemory(value: string, hostTotalMemoryBytes: number): VmMemoryAssessment {
  const requested = parseVmMemoryBytes(value)
  if (requested === null || !Number.isFinite(hostTotalMemoryBytes) || hostTotalMemoryBytes <= 0) {
    return { level: 'ok' }
  }
  if (requested >= hostTotalMemoryBytes) {
    return {
      level: 'refuse',
      message: `VM memory (${formatGb(requested)}) must be smaller than this machine's total memory (${formatGb(hostTotalMemoryBytes)}).`,
    }
  }
  if (requested > hostTotalMemoryBytes / 2) {
    return {
      level: 'warn',
      message: `${formatGb(requested)} is more than half of this machine's ${formatGb(hostTotalMemoryBytes)} of memory. The host can run out of memory and kill agents mid-task.`,
    }
  }
  return { level: 'ok' }
}
