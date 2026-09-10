import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'

test('workspace photo upload, persistence, fallback and restoration', async ({ page }) => {
  const credentials = { name: 'Ada Lovelace', email: `avatar-${Date.now()}@example.test`, password: 'AvatarTesting123!' }
  const signup = await page.request.post('/api/auth/sign-up/email', { data: credentials })
  expect(signup.ok()).toBeTruthy()
  expect((await page.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
  await page.goto('/settings/platform')
  const profile = page.getByTestId('profile-photo')
  await expect(profile).toBeVisible()
  await expect(profile.getByRole('img', { name: credentials.name })).toHaveText('AL')

  const image = new PNG({ width: 80, height: 120 })
  image.data.fill(180)
  const saved = page.waitForResponse((res) => res.url().endsWith('/api/profile/avatar') && res.request().method() === 'PUT')
  await page.getByLabel('Choose profile photo').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: PNG.sync.write(image) })
  expect((await saved).ok()).toBeTruthy()
  await expect(profile.getByRole('button', { name: 'Use account photo' })).toBeVisible()
  await expect(profile.locator('img')).toHaveAttribute('src', /\/api\/profile\/images\//)
  const imagePath = await profile.locator('img').getAttribute('src')

  await page.request.post('/api/auth/sign-out')
  await page.request.post('/api/auth/sign-in/email', { data: { email: credentials.email, password: credentials.password } })
  await page.reload()
  await expect(profile.locator('img')).toHaveAttribute('src', imagePath!)

  await page.getByLabel('Choose profile photo').setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') })
  await expect(profile.getByRole('alert')).toContainText('PNG, JPEG, or WebP')
  await expect(profile.locator('img')).toHaveAttribute('src', imagePath!)
  await profile.getByRole('button', { name: 'Use account photo' }).click()
  await expect(profile.locator('img')).toHaveCount(0)
  await expect(profile.getByRole('img', { name: credentials.name })).toHaveText('AL')
})
