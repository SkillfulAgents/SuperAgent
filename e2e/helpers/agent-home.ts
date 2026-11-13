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
 * Agent Home's sections are rows in one panel, closed until opened, then as the user last left them (a user setting
 * shared by every agent, so another test may have left one open). Opens `section` so its rows and actions can be
 * reached; a no-op when it's open.
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

/**
 * Agent Home's Add Skill (in the Skills section, which this opens): a menu (Browse skills, Upload a skill) when the agent
 * has team skills to browse, or straight to the Upload dialog when it has none. Opens the Upload dialog either way.
 */
export async function openSkillUpload(page: Page): Promise<void> {
  await openHomeSection(page, 'Skills')
  const add = page.getByTestId('add-skill-button')
  await expect(add).toBeVisible({ timeout: 10000 })
  await add.click()
  if ((await add.getAttribute('aria-haspopup')) === 'menu') await page.getByTestId('upload-skill-item').click()
}

/** Agent Home's Add Skill menu → Browse skills (the agent has team skills to browse). Opens the Skills section. */
export async function openSkillBrowse(page: Page): Promise<void> {
  await openHomeSection(page, 'Skills')
  const add = page.getByTestId('add-skill-button')
  await expect(add).toBeVisible({ timeout: 10000 })
  await add.click()
  await page.getByTestId('browse-skills-item').click()
}
