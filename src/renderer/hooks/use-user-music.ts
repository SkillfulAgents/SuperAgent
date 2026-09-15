import { useEffect, useSyncExternalStore } from 'react'
import { userMusic, type UserMusicState } from '@renderer/lib/speech/user-music'
import { getPlatform, isElectron } from '@renderer/lib/env'
import { resolveUserMusic } from '@shared/lib/voice/tts-preferences'
import { useUserSettings } from './use-user-settings'

/**
 * Whether this window can hand the hold sound to the person's own music
 * player. That player runs on the computer the window runs on and is heard
 * there, whichever Superagent the window drives, so this is a question about
 * the window itself (`isElectron()`), not about the agents' machine
 * (`canUseHostFeatures()`). Windows has no backend yet.
 */
export function userMusicSupported(): boolean {
  return isElectron() && getPlatform() !== 'win32'
}

/** The person's own preference, as voice mode applies it. */
export function useUserMusicPreference(): boolean {
  const { data: userSettings } = useUserSettings()
  return resolveUserMusic(userSettings?.voice?.userMusic)
}

/** What voice mode currently holds: nothing, or a named player. */
export function useUserMusicState(): UserMusicState {
  return useSyncExternalStore(userMusic.subscribe, userMusic.getState, userMusic.getState)
}

/**
 * Takes over a playing music player for as long as `enabled` holds, and
 * gives it back after. Whether one was found is in the returned state; the
 * hold hook then drives `userMusic` in place of the built-in loop.
 */
export function useUserMusicSession(enabled: boolean): UserMusicState {
  useEffect(() => {
    if (!enabled) return
    void userMusic.begin()
    return () => { void userMusic.end() }
  }, [enabled])
  return useUserMusicState()
}
