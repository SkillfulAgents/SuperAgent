// Optional cold-wake diagnosis: NODE_OPTIONS=--cpu-prof on one staging task (not default).
// Shape: markBoot('bound') at listen; one final boot_timing after post-bind init
// (settingsRead/dbReady may be null until then; totalMs = ready, bound = listen).

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
