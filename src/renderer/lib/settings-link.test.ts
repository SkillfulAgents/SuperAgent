import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS } from '@renderer/router/search-schemas'
import { settingsTabFromHref } from './settings-link'

describe('settingsTabFromHref', () => {
  it('returns the tab for an exact /settings/<tab> link', () => {
    expect(settingsTabFromHref('/settings/llm')).toBe('llm')
    expect(settingsTabFromHref('/settings/computer-use')).toBe('computer-use')
  })

  it('returns null for unknown tabs and other links', () => {
    expect(settingsTabFromHref('/settings/not-a-tab')).toBeNull()
    expect(settingsTabFromHref('/settings/llm/')).toBeNull()
    expect(settingsTabFromHref('https://example.com/settings/llm')).toBeNull()
    expect(settingsTabFromHref(undefined)).toBeNull()
  })

  it('every tab ID in the agent guide is a real Settings tab', () => {
    const guide = readFileSync(join(__dirname, '../../../agent-container/docs/in-app-links.md'), 'utf8')
    const ids = [...guide.matchAll(/^\| `([\w-]+)` \|/gm)].map((match) => match[1])
    expect(ids.length).toBeGreaterThan(10)
    for (const id of ids) expect(SETTINGS_TABS).toContain(id)
  })
})
