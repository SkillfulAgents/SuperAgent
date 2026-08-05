// Boot phase marks → one grep-friendly `boot_timing {json}` line after post-bind init.

type BootMark = 'modulesLoaded' | 'settingsRead' | 'dbReady' | 'bound'

const marks: Partial<Record<BootMark, number>> = {}

function elapsedMs(): number {
  // process.uptime() is from real process start — no "import this module first" constraint.
  return Math.round(process.uptime() * 1000 * 10) / 10
}

function processStartIso(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString()
}

/** Idempotent per name; values are ms since process start. */
export function markBoot(name: BootMark): void {
  if (marks[name] !== undefined) return
  marks[name] = elapsedMs()
}

/** Call once after post-bind init finishes. */
export function logBootTiming(): void {
  console.log(
    `boot_timing ${JSON.stringify({
      processStart: processStartIso(),
      modulesLoaded: marks.modulesLoaded ?? null,
      settingsRead: marks.settingsRead ?? null,
      dbReady: marks.dbReady ?? null,
      bound: marks.bound ?? null,
      totalMs: elapsedMs(),
    })}`,
  )
}
