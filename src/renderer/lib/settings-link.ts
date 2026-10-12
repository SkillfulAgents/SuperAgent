import { settingsTabSchema, type SettingsTab } from '@renderer/router/search-schemas'

const SETTINGS_LINK = /^\/settings\/([\w-]+)$/

/** The Settings tab an in-app link like `/settings/llm` points at, or null for any other href. */
export function settingsTabFromHref(href: string | undefined): SettingsTab | null {
  const tab = href?.match(SETTINGS_LINK)?.[1]
  return settingsTabSchema.safeParse(tab).data ?? null
}
