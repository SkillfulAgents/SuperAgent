import { useEffect, useState } from 'react'
import { getActiveTarget } from '@renderer/lib/api-target'

/**
 * A yes/no answer about the current Superagent, remembered across reloads.
 *
 * For chrome that appears only when the answer is yes. Such an item cannot be
 * rendered until its answer arrives, so it pops into place a beat after
 * everything else and shoves whatever is under it down — and after a target
 * switch that beat lands right as the transition finishes, which is precisely
 * when someone is watching the sidebar.
 *
 * The previous answer *for this target* is the right thing to show meanwhile: it
 * is what they were looking at before the switch, and it is wrong only in the
 * moment a workspace gains or loses the thing being asked about. Storing it per
 * target matters — the two Superagents have different skillsets, agents and
 * settings, and one's answer is no evidence about the other's.
 *
 * @param name  Identifies the question. Scoped per target internally.
 * @param answer The live answer, or null while it is still unknown.
 */
export function useRememberedFlag(name: string, answer: boolean | null): boolean {
  const key = `remembered.${name}.${getActiveTarget()}`
  // Read once, at mount: this is what was true last time, and re-reading it
  // later would fight the live answer that is about to replace it.
  const [remembered] = useState(() => localStorage.getItem(key) === '1')

  useEffect(() => {
    if (answer !== null) localStorage.setItem(key, answer ? '1' : '0')
  }, [key, answer])

  return answer ?? remembered
}
