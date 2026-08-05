// Boot phase timing: markBoot() per phase, one boot_timing log line after post-bind init.
// bound = listen time; totalMs = ready (log) time; unmarked phases log as null.

const originMs = performance.now()
const processStartIso = new Date().toISOString()

type BootMark = 'modulesLoaded' | 'settingsRead' | 'dbReady' | 'bound'

const marks: Partial<Record<BootMark, number>> = {}

function elapsedMs(): number {
  return Math.round((performance.now() - originMs) * 10) / 10
}

/** Record a boot phase mark (ms since processStart). Idempotent per name. */
export function markBoot(name: BootMark): void {
  if (marks[name] !== undefined) return
  marks[name] = elapsedMs()
}

/** Structured, grep-friendly summary. Call once after post-bind init finishes. */
export function logBootTiming(): void {
  const payload = {
    processStart: processStartIso,
    modulesLoaded: marks.modulesLoaded ?? null,
    settingsRead: marks.settingsRead ?? null,
    dbReady: marks.dbReady ?? null,
    bound: marks.bound ?? null,
    totalMs: elapsedMs(),
  }
  console.log(`boot_timing ${JSON.stringify(payload)}`)
}
