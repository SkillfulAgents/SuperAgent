import { expect, type Page } from '@playwright/test'

/**
 * Agent Home's widgets, sections and Show more sit in a side panel that is always there: beside the page from xl,
 * below its content narrower. Waits for it and brings it into view.
 */
export async function openHomeSidePanel(page: Page): Promise<void> {
  const panel = page.getByTestId('agent-home-side-panel')
  await expect(panel).toBeAttached({ timeout: 10000 })
  await panel.scrollIntoViewIfNeeded()
  await expect(panel).toBeVisible()
}

export type HomeSection = 'Triggers' | 'Connections' | 'Skills' | 'External Integrations' | 'Drives' | 'Hooks'

/**
 * Agent Home's sections are rows in one panel, collapsed until opened. Opens
 * `section` so its rows and actions can be reached; a no-op when it's open.
 * Each visit to Agent Home starts collapsed again (the side panel as the user left it), so call it after landing.
 */
export async function openHomeSection(page: Page, section: HomeSection): Promise<void> {
  await openHomeSidePanel(page)
  const header = page.getByTestId('home-sections-panel').getByRole('button', { name: section, exact: true })
  await expect(header).toBeVisible({ timeout: 10000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

/**
 * Agent Home's per-agent pickers and its links (Memories, Secrets, API Logs, …)
 * sit behind a closed "Show more" toggle. Opens it; a no-op when open.
 */
export async function openHomeAdvancedSettings(page: Page): Promise<void> {
  await openHomeSidePanel(page)
  const toggle = page.getByTestId('home-advanced-settings-toggle')
  await expect(toggle).toBeVisible({ timeout: 10000 })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/** Agent Home's Import (in the Skills section, which this opens): opens the Import dialog. */
export async function openSkillUpload(page: Page): Promise<void> {
  await openHomeSection(page, 'Skills')
  const importButton = page.getByTestId('import-skill-button')
  await expect(importButton).toBeVisible({ timeout: 10000 })
  await importButton.click()
}

/** Agent Home's Add Skill (the agent has team skills to browse): opens the browse dialog. Opens the Skills section. */
export async function openSkillBrowse(page: Page): Promise<void> {
  await openHomeSection(page, 'Skills')
  const add = page.getByTestId('add-skill-button')
  await expect(add).toBeVisible({ timeout: 10000 })
  await add.click()
}
