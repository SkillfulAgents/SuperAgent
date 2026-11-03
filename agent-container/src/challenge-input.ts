/**
 * Human-like mouse input on sites that served a challenge wall.
 *
 * agent-browser 0.38+ can move the mouse along a curved, eased path before a
 * click (`click --human`). It is never the default: on a test page its path
 * crossed a hover menu, the menu covered the target and the click failed
 * where the instant click succeeded; it adds 0.1–1 s per click; and it only
 * covers the mouse (hover still jumps, fill sends no keystrokes). So it is
 * switched on only where bot scoring is known to be active: on a page the
 * observer identifies as a challenge wall (Cloudflare, PerimeterX, DataDome,
 * Imperva, Akamai, Google), and afterwards on that site for the rest of the
 * browser session — the same vendor scores the pages behind the wall.
 *
 * SUPERAGENT_BROWSER_HUMAN_INPUT overrides it: `off` never, `always` on
 * every click (for benchmarking), anything else the default above.
 */
import type { PageObservation } from './page-observer'

export type HumanInputMode = 'challenge' | 'off' | 'always'

export function humanInputMode(env: NodeJS.ProcessEnv = process.env): HumanInputMode {
  const v = (env.SUPERAGENT_BROWSER_HUMAN_INPUT ?? '').trim().toLowerCase()
  return v === 'off' || v === 'always' ? v : 'challenge'
}

/** A site as the challenge vendors scope it: the host without a leading www. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

const challengedSites = new Set<string>()

/** Record the site of any observation that showed a challenge wall. */
export function noteChallenge(obs: Pick<PageObservation, 'url' | 'blocker'> | null | undefined): void {
  if (!obs?.blocker) return
  const site = siteOf(obs.url)
  if (site) challengedSites.add(site)
}

/** Should the next click on this page use the human-like path? */
export function useHumanInput(obs: Pick<PageObservation, 'url' | 'blocker'> | null, mode: HumanInputMode = humanInputMode()): boolean {
  if (mode === 'off') return false
  if (mode === 'always') return true
  if (!obs) return false
  if (obs.blocker) return true
  const site = siteOf(obs.url)
  return site !== '' && challengedSites.has(site)
}

export function resetChallengedSites(): void {
  challengedSites.clear()
}
