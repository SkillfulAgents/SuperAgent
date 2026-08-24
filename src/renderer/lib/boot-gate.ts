export type WizardAutoOpenDecision = 'wait' | 'release' | 'open-full' | 'open-agent-only'

type SettingsFlag = { setupCompleted?: boolean } | null | undefined

// The first-boot wizard decision. Callers apply the result; this function
// does not know about React state or the outlet.
export function decideWizardAutoOpen(input: {
  userSettings: SettingsFlag
  globalSettings: SettingsFlag
  isAuthMode: boolean
  isAdmin: boolean
}): WizardAutoOpenDecision {
  // /api/settings is admin-gated. Non-admins never get globalSettings, so
  // waiting on it holds a blank boot surface for the life of a 403 (or a remount).
  if (input.isAuthMode && !input.isAdmin) return 'release'

  if (!input.userSettings) return 'wait'
  if (input.userSettings.setupCompleted) return 'release'

  if (!input.isAuthMode) return 'open-full'
  if (!input.globalSettings) return 'wait'
  if (!input.globalSettings.setupCompleted && input.isAdmin) return 'open-full'
  if (input.globalSettings.setupCompleted) return 'open-agent-only'
  return 'release'
}
