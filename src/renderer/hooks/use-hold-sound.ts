import { useEffect, useRef } from 'react'
import { readAloud } from './use-read-aloud'
import { holdSound } from '@renderer/lib/speech/hold-sound'

/** How often to check whether the reply is audible. */
const POLL_MS = 200
/** Once the agent is working, silence this long starts the loop: gaps between sentences are shorter. */
export const HOLD_DELAY_MS = 700
/**
 * Before the turn's first tool call the agent is usually about to say
 * something ("I'll look that up"), so the loop waits much longer: starting
 * it and then cutting it for a four-word sentence is worse than a pause.
 */
export const HOLD_DELAY_BEFORE_TOOLS_MS = 3_000

interface UseHoldSoundArgs {
  /** Voice mode is on and the person wants the sound. */
  enabled: boolean
  /** The agent has the floor: the sound fills any silence until it speaks. */
  agentTurn: boolean
  /** The turn has reached a tool call: the agent is working, and silence is expected. */
  working: boolean
}

/**
 * Plays the hold loop whenever the agent is working and nothing is being
 * heard: through a tool call, and in the silence between spoken sentences
 * around one. Before the turn's first tool call it holds off unless the
 * silence runs long, so an opening sentence is spoken over nothing. Stops
 * the moment the reply is audible, or the floor returns to the person.
 */
export function useHoldSound({ enabled, agentTurn, working }: UseHoldSoundArgs): void {
  // Read live by the poll, not an effect dependency: a change must not
  // restart the sound that is already playing.
  const workingRef = useRef(working)
  workingRef.current = working

  // Start the download when voice mode comes on, not on the first hold.
  useEffect(() => {
    if (enabled) holdSound.prime()
  }, [enabled])

  useEffect(() => {
    if (!enabled || !agentTurn) return
    let silentSince: number | null = Date.now()
    const check = () => {
      if (readAloud.isAudible()) {
        silentSince = null
        holdSound.stop()
        return
      }
      silentSince ??= Date.now()
      const delay = workingRef.current ? HOLD_DELAY_MS : HOLD_DELAY_BEFORE_TOOLS_MS
      if (Date.now() - silentSince >= delay) holdSound.start()
    }
    const timer = setInterval(check, POLL_MS)
    return () => {
      clearInterval(timer)
      holdSound.stop()
    }
  }, [enabled, agentTurn])
}
