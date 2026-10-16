import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS } from '@renderer/router/search-schemas'
import { AGENT_ITEM_PAGES, AGENT_PAGES, isAgentPageHref, settingsTabFromHref } from './in-app-link'

const guide = readFileSync(join(__dirname, '../../../agent-container/docs/in-app-links.md'), 'utf8')

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
    const ids = [...guide.matchAll(/^\| `([\w-]+)` \|/gm)].map((match) => match[1])
    expect(ids.length).toBeGreaterThan(10)
    for (const id of ids) expect(SETTINGS_TABS).toContain(id)
  })
})

describe('isAgentPageHref', () => {
  it('accepts the agent home and known agent pages', () => {
    expect(isAgentPageHref('/agents/sales-helper')).toBe(true)
    expect(isAgentPageHref('/agents/sales-helper/secrets')).toBe(true)
    expect(isAgentPageHref('/agents/sales-helper/api-logs')).toBe(true)
    expect(isAgentPageHref('/agents/sales-helper/dashboards/weekly-sales')).toBe(true)
    expect(isAgentPageHref('/agents/sales-helper/tasks/3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d')).toBe(true)
  })

  it('rejects unknown pages and other links', () => {
    expect(isAgentPageHref('/agents/sales-helper/not-a-page')).toBe(false)
    expect(isAgentPageHref('/agents/sales-helper/')).toBe(false)
    expect(isAgentPageHref('/agents/sales-helper/sessions/abc')).toBe(false)
    expect(isAgentPageHref('/agents/sales-helper/dashboards')).toBe(false)
    expect(isAgentPageHref('/agents/sales-helper/secrets/abc')).toBe(false)
    expect(isAgentPageHref('https://example.com/agents/sales-helper')).toBe(false)
    expect(isAgentPageHref(undefined)).toBe(false)
  })

  it('the agent guide lists exactly the supported agent pages', () => {
    const rows = [...guide.matchAll(/^\| `\/agents\/<slug>(?:\/([\w-]+))?(\/<[\w-]+>)?` \|/gm)]
    expect(rows.some((row) => row[1] === undefined)).toBe(true)
    const pages = rows.filter((row) => row[1] && !row[2]).map((row) => row[1])
    const itemPages = rows.filter((row) => row[2]).map((row) => row[1])
    expect(pages.sort()).toEqual([...AGENT_PAGES].sort())
    expect(itemPages.sort()).toEqual([...AGENT_ITEM_PAGES].sort())
  })
})
