import { expect, request as playwrightRequest, type APIRequestContext, type Locator, type Page, type Request, type Route } from '@playwright/test'
import { z } from 'zod'

export interface FormsContext {
  page: Page
  apiBaseUrl: string
  adminRequest: APIRequestContext
  navigate: (route: string) => Promise<unknown>
  runtime: 'web' | 'electron'
  touch?: boolean
  authenticatedRequest?: APIRequestContext
  reauthenticate?: (user: FormsUser) => Promise<void>
  captureFailure?: () => Promise<void>
}

const userSchema = z.object({ id: z.string(), name: z.string(), email: z.string(), mustChangePassword: z.boolean().optional() })
const sessionSchema = z.object({ user: userSchema }).nullable()
const authSettingsSchema = z.object({ auth: z.object({ passwordMinLength: z.number(), passwordRequireComplexity: z.boolean() }) })
const admin = { name: 'Forms Validation Admin', email: 'forms-admin@e2e.test', password: 'Forms-Admin-2026-Strong!' }
const password = 'Forms-Original-2026!'
const nextPassword = 'Forms-Replacement-2026!'
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
export type FormsUser = { name: string; email: string; password: string; id?: string }

export async function initializeFormsAdmin(request: APIRequestContext, apiBaseUrl: string) {
  const configResponse = await request.get(`${apiBaseUrl}/api/auth-config`)
  expect(configResponse.ok()).toBe(true)
  const config = z.object({ hasUsers: z.boolean() }).parse(await configResponse.json())
  const response = await request.post(`${apiBaseUrl}/api/auth/${config.hasUsers ? 'sign-in' : 'sign-up'}/email`, {
    headers: { Origin: apiBaseUrl }, data: admin,
  })
  expect(response.ok(), 'Initialize the isolated forms administrator').toBe(true)
  return userSchema.parse(z.object({ user: userSchema }).parse(await response.json()).user)
}

async function activate(context: FormsContext, locator: Locator) {
  if (context.touch) await locator.tap()
  else await locator.click()
}

async function inViewport(page: Page, locator: Locator) {
  if (!(await locator.count())) return false
  const box = await locator.boundingBox()
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  return !!box && !!viewport && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height
}

async function session(context: FormsContext) {
  const response = await (context.authenticatedRequest ?? context.page.context().request).get(`${context.apiBaseUrl}/api/auth/get-session`)
  expect(response.ok()).toBe(true)
  return sessionSchema.parse(await response.json())
}

async function policy(context: FormsContext, minLength: number, complexity: boolean) {
  const response = await context.adminRequest.put(`${context.apiBaseUrl}/api/settings`, {
    data: { auth: { passwordMinLength: minLength, passwordRequireComplexity: complexity } },
  })
  expect(response.ok(), 'Set the real deployment password policy').toBe(true)
}

async function ready(context: FormsContext) {
  const { page } = context
  const request = context.authenticatedRequest ?? page.context().request
  const response = await request.put(`${context.apiBaseUrl}/api/user-settings`, { data: { setupCompleted: true } })
  expect(response.ok()).toBe(true)
  const name = page.getByLabel('Name', { exact: true })
  if (page.url() === 'about:blank') {
    await context.navigate('/settings/platform')
  } else if (!page.url().includes('/settings')) {
    // Open settings through the app. A document navigation during initial
    // authentication can cancel the template-catalog fetch in WebKit.
    const menu = page.getByTestId('user-menu-trigger')
    await expect(page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).first()).toBeVisible()
    if (!(await inViewport(page, menu))) {
      await activate(context, page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).first())
    }
    await activate(context, menu)
    await activate(context, page.getByTestId('settings-button'))
  }
  const settings = page.getByTestId('global-settings-page')
  await expect(settings).toBeVisible()
  if (!page.url().includes('/settings/platform')) {
    const account = page.getByTestId('settings-nav-platform')
    // Narrow Settings has a menu/content stack, separate from the app sidebar.
    if (!(await inViewport(page, account))) await activate(context, settings.getByRole('button').first())
    await activate(context, account)
  }
  await expect(name).toBeVisible()
}

async function signIn(context: FormsContext, user: FormsUser) {
  await context.navigate('/')
  await expect(context.page.getByTestId('auth-page')).toBeVisible()
  await context.page.locator('#signin-email').fill(user.email)
  await context.page.locator('#signin-password').fill(user.password)
  await activate(context, context.page.getByTestId('signin-submit'))
  await expect.poll(async () => (await session(context))?.user.email).toBe(user.email)
}

async function withUser(context: FormsContext, mode: 'existing' | 'signup' | 'invited', check: (user: FormsUser) => Promise<void>) {
  const user: FormsUser = { name: 'Forms User', email: `forms-${crypto.randomUUID()}@e2e.test`, password }
  const settingsResponse = await context.adminRequest.get(`${context.apiBaseUrl}/api/settings`)
  expect(settingsResponse.ok()).toBe(true)
  const before = authSettingsSchema.parse(await settingsResponse.json())
  let failure: unknown
  try {
    await context.page.context().clearCookies()
    await policy(context, 8, false)
    if (mode === 'invited') {
      const response = await context.adminRequest.post(`${context.apiBaseUrl}/api/admin/users/invite`, { data: user })
      expect(response.ok()).toBe(true)
      user.id = z.object({ user: userSchema }).parse(await response.json()).user.id
    } else if (mode === 'existing') {
      const response = await context.page.context().request.post(`${context.apiBaseUrl}/api/auth/sign-up/email`, {
        headers: { Origin: context.apiBaseUrl }, data: user,
      })
      expect(response.ok()).toBe(true)
      user.id = z.object({ user: userSchema }).parse(await response.json()).user.id
    }
    await check(user)
  } catch (error) {
    failure = error
    try { await context.captureFailure?.() } catch (captureError) { failure = new AggregateError([error, captureError], `Form scenario failed: ${errorMessage(error)}; failure capture failed: ${errorMessage(captureError)}`) }
  }
  try {
    await context.page.unrouteAll({ behavior: 'ignoreErrors' })
    await context.page.context().clearCookies()
    await context.navigate('/')
    if (!user.id && mode === 'signup') {
      const response = await context.adminRequest.get(`${context.apiBaseUrl}/api/auth/admin/list-users`, { params: { searchValue: user.email, searchField: 'email', searchOperator: 'eq' } })
      expect(response.ok()).toBe(true)
      user.id = z.object({ users: z.array(userSchema) }).parse(await response.json()).users.find((candidate) => candidate.email === user.email)?.id
    }
    if (user.id) {
      const response = await context.adminRequest.post(`${context.apiBaseUrl}/api/auth/admin/remove-user`, {
        headers: { Origin: context.apiBaseUrl }, data: { userId: user.id },
      })
      expect(response.ok(), 'Remove only this scenario’s account').toBe(true)
    }
    const response = await context.adminRequest.put(`${context.apiBaseUrl}/api/settings`, { data: { auth: before.auth } })
    expect(response.ok(), 'Restore the prior auth policy').toBe(true)
  } catch (cleanupError) {
    failure = failure ? new AggregateError([failure, cleanupError], `Form scenario failed: ${errorMessage(failure)}; cleanup failed: ${errorMessage(cleanupError)}`) : cleanupError
  }
  if (failure) throw failure
}

/** Hold the actual request, then send it to the real API when released. */
async function holdRequest(page: Page, path: string, method = 'POST') {
  let release!: () => void
  let calls = 0
  const gate = new Promise<void>((resolve) => { release = resolve })
  const handlers: Promise<void>[] = []
  const errors: unknown[] = []
  const handler = (route: Route) => {
    const work = (async () => {
      if (route.request().method() === method) {
        calls += 1
        await gate
      }
      await route.continue()
    })().catch((error: unknown) => { errors.push(error) })
    handlers.push(work)
    return work
  }
  await page.route(`**${path}`, handler)
  const stop = async () => {
    release()
    await page.unroute(`**${path}`, handler)
    await Promise.all(handlers)
    if (errors.length) throw new AggregateError(errors, `Held API request failed: ${errors.map(errorMessage).join('; ')}`)
  }
  return {
    release,
    calls: () => calls,
    check: async (action: () => Promise<void>) => {
      let failure: unknown
      try { await action() } catch (error) { failure = error }
      try { await stop() } catch (cleanupError) {
        failure = failure ? new AggregateError([failure, cleanupError], `Form assertion failed: ${errorMessage(failure)}; request cleanup failed: ${errorMessage(cleanupError)}`) : cleanupError
      }
      if (failure) throw failure
    },
  }
}

async function checkSignIn(context: FormsContext) {
  await withUser(context, 'existing', async (user) => {
    const { page } = context
    await page.context().clearCookies()
    await context.navigate('/')
    await expect(page.getByTestId('signin-submit')).toBeVisible()
    await page.locator('#signin-email').fill(user.email)
    await activate(context, page.getByTestId('signin-submit'))
    await expect(page.getByText('Password is required', { exact: true })).toBeVisible()
    await expect(page.locator('#signin-password')).toBeFocused()
    await page.locator('#signin-password').fill('Wrong-password-2026!')
    await activate(context, page.getByTestId('signin-submit'))
    await expect(page.getByTestId('signin-error')).toBeVisible()
    expect(await session(context)).toBeNull()
    await page.locator('#signin-password').fill(user.password)
    const held = await holdRequest(page, '/api/auth/sign-in/email')
    await held.check(async () => {
      await activate(context, page.getByTestId('signin-submit'))
      await expect.poll(held.calls).toBe(1)
      await expect(page.getByTestId('signin-submit')).toBeDisabled()
      await page.locator('#signin-password').press('Enter')
      expect(held.calls()).toBe(1)
      held.release()
      await expect.poll(async () => (await session(context))?.user.email).toBe(user.email)
      await ready(context)
      expect(held.calls()).toBe(1)
      await page.reload()
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue(user.name)
    })
  })
}

async function checkSignup(context: FormsContext) {
  await withUser(context, 'signup', async (user) => {
    const { page } = context
    await policy(context, 16, true)
    const heldConfig = await holdRequest(page, '/api/auth-config', 'GET')
    await heldConfig.check(async () => {
      await context.navigate('/')
      await expect(page.getByTestId('auth-config-loading')).toBeVisible()
      await expect(page.getByTestId('signup-submit')).toHaveCount(0)
      heldConfig.release()
      await activate(context, page.getByTestId('auth-tab-signup'))
      await expect(page.locator('#signup-password')).toHaveAttribute('placeholder', 'At least 16 chars, mixed case + number + symbol')
    })
    await page.locator('#signup-email').fill(user.email)
    await page.locator('#signup-password').fill('short')
    await page.locator('#signup-confirm').fill('different')
    await activate(context, page.getByTestId('signup-submit'))
    await expect(page.getByText('Name is required', { exact: true })).toBeVisible()
    await expect(page.getByText('Password must be at least 16 characters', { exact: true })).toBeVisible()
    await expect(page.getByText('Passwords do not match', { exact: true })).toBeVisible()
    await expect(page.locator('#signup-name')).toBeFocused()
    await page.locator('#signup-name').fill(user.name)
    await page.locator('#signup-password').fill('alllowercasepassword')
    await page.locator('#signup-confirm').fill('alllowercasepassword')
    await activate(context, page.getByTestId('signup-submit'))
    await expect(page.getByText('Must contain an uppercase letter', { exact: true })).toBeVisible()
    expect(await session(context)).toBeNull()
    // Tab unmount discards unsaved values and errors before the successful attempt.
    await activate(context, page.getByTestId('auth-tab-signin'))
    await activate(context, page.getByTestId('auth-tab-signup'))
    await expect(page.locator('#signup-name')).toHaveValue('')
    await expect(page.getByText('Must contain an uppercase letter', { exact: true })).toHaveCount(0)
    await page.locator('#signup-name').fill(user.name)
    await page.locator('#signup-email').fill(user.email)
    await page.locator('#signup-password').fill(user.password)
    await page.locator('#signup-confirm').fill(user.password)
    const held = await holdRequest(page, '/api/auth/sign-up/email')
    await held.check(async () => {
      await activate(context, page.getByTestId('signup-submit'))
      await expect.poll(held.calls).toBe(1)
      await expect(page.getByTestId('signup-submit')).toBeDisabled()
      await page.locator('#signup-confirm').press('Enter')
      held.release()
      await expect.poll(async () => (await session(context))?.user.email).toBe(user.email)
      user.id = (await session(context))!.user.id
      await ready(context)
      expect(held.calls()).toBe(1)
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue(user.name)
    })
  })
}

async function checkProfileName(context: FormsContext) {
  await withUser(context, 'existing', () => checkProfileNameForm(context))
}

export async function checkProfileNameForm(context: FormsContext) {
    const { page } = context
    await ready(context)
    const initialName = (await session(context))!.user.name
    const name = page.getByLabel('Name', { exact: true })
    const save = page.locator('form').filter({ has: name }).getByRole('button')
    await expect(save).toBeDisabled()
    await name.fill('')
    await activate(context, save)
    await expect(page.getByText('Name is required', { exact: true })).toBeVisible()
    await expect(name).toBeFocused()
    await name.fill('Forms Saved Name')
    await page.route('**/api/auth/update-user', (route) => route.fulfill({ status: 503, json: { code: 'VALIDATION_SERVICE_UNAVAILABLE', message: 'Temporary profile service failure' } }), { times: 1 })
    await activate(context, save)
    await expect(page.getByText('Error: Temporary profile service failure', { exact: true })).toBeVisible()
    await expect(name).toHaveValue('Forms Saved Name')
    await expect(save).toBeEnabled()
    expect((await session(context))!.user.name).toBe(initialName)
    const held = await holdRequest(page, '/api/auth/update-user')
    await held.check(async () => {
      await activate(context, save)
      await expect.poll(held.calls).toBe(1)
      await expect(save).toBeDisabled()
      await expect(name).toHaveAttribute('readonly', '')
      await name.focus()
      await name.pressSequentially('must-not-overwrite')
      await expect(name).toHaveValue('Forms Saved Name')
      await name.press('Enter')
      held.release()
      await expect.poll(async () => (await session(context))?.user.name).toBe('Forms Saved Name')
      await expect(save).toBeDisabled()
      await expect(name).toBeEditable()
      await name.focus()
      await name.press('Tab')
      await expect(save).toBeDisabled()
      expect(held.calls()).toBe(1)
    })
    await name.fill('Unsaved edit')
    await expect(save).toBeEnabled()
    await name.fill('Forms Saved Name')
    await name.press('Tab')
    await expect(save).toBeDisabled()
    await name.fill('Forms Second Name')
    await activate(context, save)
    await expect.poll(async () => (await session(context))?.user.name).toBe('Forms Second Name')
    await expect(save).toBeDisabled()
    await name.fill('Discard on remount')
    // A full remount drops the unsaved draft and reads the persisted baseline.
    await page.reload()
    await expect(name).toHaveValue('Forms Second Name')
    await expect(save).toBeDisabled()
}

async function checkProfilePassword(context: FormsContext) {
  await withUser(context, 'existing', (user) => checkProfilePasswordForm(context, user))
}

export async function checkProfilePasswordForm(context: FormsContext, user: FormsUser) {
    const { page } = context
    await ready(context)
    await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeVisible()
    await policy(context, 16, true)
    const heldConfig = await holdRequest(page, '/api/auth-config', 'GET')
    await heldConfig.check(async () => {
      await activate(context, page.getByRole('button', { name: 'Change password', exact: true }))
      await expect(page.getByLabel('New password', { exact: true })).toHaveAttribute('placeholder', 'At least 12 chars, mixed case + number + symbol')
      await page.getByLabel('Current password', { exact: true }).fill(user.password)
      await page.getByLabel('New password', { exact: true }).fill('Short-2026!Aa')
      await page.getByLabel('Confirm new password', { exact: true }).fill('Mismatch-2026!')
      heldConfig.release()
      await expect(page.getByLabel('New password', { exact: true })).toHaveAttribute('placeholder', 'At least 16 chars, mixed case + number + symbol')
      await expect(page.getByLabel('New password', { exact: true })).toHaveValue('Short-2026!Aa')
    })
    await activate(context, page.getByRole('button', { name: 'Change password', exact: true }))
    await expect(page.getByText('Password must be at least 16 characters', { exact: true })).toBeVisible()
    await expect(page.getByText('Passwords do not match', { exact: true })).toBeVisible()
    await activate(context, page.getByRole('button', { name: 'Cancel', exact: true }))
    await activate(context, page.getByRole('button', { name: 'Change password', exact: true }))
    await expect(page.getByLabel('Current password', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('New password', { exact: true })).toHaveValue('')
    await expect(page.getByText('Passwords do not match', { exact: true })).toHaveCount(0)
    await page.getByLabel('Current password', { exact: true }).fill('Wrong-password-2026!')
    await page.getByLabel('New password', { exact: true }).fill(nextPassword)
    await page.getByLabel('Confirm new password', { exact: true }).fill(nextPassword)
    await activate(context, page.getByRole('button', { name: 'Change password', exact: true }))
    await expect(page.getByText('Error: Invalid password', { exact: true })).toBeVisible()
    await expect(page.getByLabel('New password', { exact: true })).toHaveValue(nextPassword)
    await page.getByLabel('Current password', { exact: true }).fill(user.password)
    const held = await holdRequest(page, '/api/auth/change-password')
    await held.check(async () => {
      await activate(context, page.getByRole('button', { name: 'Change password', exact: true }))
      await expect.poll(held.calls).toBe(1)
      await expect(page.getByRole('button', { name: 'Changing password…', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
      await page.getByLabel('Confirm new password', { exact: true }).press('Enter')
      held.release()
      await expect(page.getByLabel('Current password', { exact: true })).toHaveCount(0)
      expect(held.calls()).toBe(1)
    })
    if (context.reauthenticate) {
      await context.reauthenticate({ ...user, password: nextPassword })
    } else {
      await page.context().clearCookies()
      await signIn(context, { ...user, password: nextPassword })
    }
    await ready(context)
    await activate(context, page.getByRole('button', { name: 'Change password', exact: true }))
    await expect(page.getByLabel('Current password', { exact: true })).toHaveValue('')
}

async function checkForcedPassword(context: FormsContext) {
  await withUser(context, 'invited', async (user) => {
    const { page } = context
    const otherSession = await playwrightRequest.newContext({ baseURL: context.apiBaseUrl, extraHTTPHeaders: { Origin: context.apiBaseUrl } })
    try {
    const otherLogin = await otherSession.post('/api/auth/sign-in/email', { data: { email: user.email, password: user.password } })
    expect(otherLogin.ok()).toBe(true)
    expect(sessionSchema.parse(await (await otherSession.get('/api/auth/get-session')).json())?.user.id).toBe(user.id)
    await signIn(context, user)
    await expect(page.getByRole('heading', { name: 'Change Your Password', exact: true })).toBeVisible()
    expect((await session(context))!.user.mustChangePassword).toBe(true)
    await expect(page.getByTestId('app-sidebar')).toHaveCount(0)
    await activate(context, page.getByRole('button', { name: 'Change Password', exact: true }))
    await expect(page.getByText('Current password is required', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Temporary Password', { exact: true })).toBeFocused()
    await page.getByLabel('Temporary Password', { exact: true }).fill(user.password)
    await page.getByLabel('New Password', { exact: true }).fill(user.password)
    await page.getByLabel('Confirm New Password', { exact: true }).fill(user.password)
    await activate(context, page.getByRole('button', { name: 'Change Password', exact: true }))
    await expect(page.getByText('New password must be different from current password', { exact: true })).toBeVisible()
    await page.getByLabel('New Password', { exact: true }).fill(nextPassword)
    await page.getByLabel('Confirm New Password', { exact: true }).fill('mismatch')
    await activate(context, page.getByRole('button', { name: 'Change Password', exact: true }))
    await expect(page.getByText('Passwords do not match', { exact: true })).toBeVisible()
    await page.getByLabel('Confirm New Password', { exact: true }).fill(nextPassword)
    await page.getByLabel('Temporary Password', { exact: true }).fill('Wrong-temporary-2026!')
    const changePasswordUrl = `${context.apiBaseUrl}/api/auth/change-password`
    // Exercise pending state and duplicate submission on the real rejected
    // request, then remove interception before the successful native reload.
    const held = await holdRequest(page, '/api/auth/change-password')
    await held.check(async () => {
      await activate(context, page.getByRole('button', { name: 'Change Password', exact: true }))
      await expect.poll(held.calls).toBe(1)
      await expect(page.getByRole('button', { name: 'Changing password...', exact: true })).toBeDisabled()
      await page.getByLabel('Confirm New Password', { exact: true }).press('Enter')
      const rejected = page.waitForResponse((response) => response.url() === changePasswordUrl && response.request().method() === 'POST', { timeout: 10_000 })
      held.release()
      expect((await rejected).status()).toBe(400)
      await expect(page.getByText('Invalid password', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Change Password', exact: true })).toBeEnabled()
      await expect(page.getByLabel('New Password', { exact: true })).toHaveValue(nextPassword)
      expect(held.calls()).toBe(1)
    })
    await page.getByLabel('Temporary Password', { exact: true }).fill(user.password)
    // Observe the successful request, automatic reload, and a session fetched
    // by the NEW renderer, without intercepting any navigation or API request.
    const reloadUrl = page.url()
    let committed = false
    let successfulSubmissions = 0
    const rendererRequests = new Set<Request>()
    const onCommit = (frame: ReturnType<Page['mainFrame']>) => {
      if (frame === page.mainFrame() && frame.url() === reloadUrl) committed = true
    }
    const onRequest = (request: Request) => {
      if (request.method() === 'POST' && request.url() === changePasswordUrl) successfulSubmissions += 1
      if (committed && request.frame() === page.mainFrame() && request.method() === 'GET' && request.url() === `${context.apiBaseUrl}/api/auth/get-session`) rendererRequests.add(request)
    }
    page.on('framenavigated', onCommit)
    page.on('request', onRequest)
    const changed = page.waitForResponse((response) => response.url() === changePasswordUrl && response.request().method() === 'POST', { timeout: 30_000 })
    const reload = page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() && frame.url() === reloadUrl, timeout: 30_000 })
    const rendererSession = page.waitForResponse((response) => rendererRequests.has(response.request()), { timeout: 30_000 })
    try {
      const [changedResponse, , response] = await Promise.all([changed, reload, rendererSession, activate(context, page.getByRole('button', { name: 'Change Password', exact: true }))])
      expect(changedResponse.status()).toBe(200)
      expect(response.status(), 'The reloaded renderer fetches its real session').toBe(200)
      const refreshed = sessionSchema.parse(await response.json())
      expect(refreshed?.user.id).toBe(user.id)
      expect(refreshed?.user.mustChangePassword).toBe(false)
      // Document teardown alone does not prove the app recovered.
      await ready(context)
      expect(successfulSubmissions).toBe(1)
    } finally {
      page.off('framenavigated', onCommit)
      page.off('request', onRequest)
    }
    await expect(page.getByRole('heading', { name: 'Change Your Password', exact: true })).toHaveCount(0)
    await expect.poll(async () => (await session(context))?.user.mustChangePassword).toBe(false)
    const revoked = await otherSession.get('/api/auth/get-session')
    expect(revoked.ok()).toBe(true)
    expect(sessionSchema.parse(await revoked.json())).toBeNull()
    await page.context().clearCookies()
    await signIn(context, { ...user, password: nextPassword })
    await expect(page.getByRole('heading', { name: 'Change Your Password', exact: true })).toHaveCount(0)
    await ready(context)
    } finally { await otherSession.dispose() }
  })
}

export const accountFormScenarios: readonly (readonly [string, (context: FormsContext) => Promise<void>])[] = [
  ['sign-in validates, recovers from rejection and submits once while pending', checkSignIn],
  ['sign-up awaits policy, validates corrected fields and resets across tabs', checkSignup],
  ['profile name recovers from save failure and re-baselines dirty state after save', checkProfileName],
  ['profile password adopts arriving policy and recovers through cancel and retry', checkProfilePassword],
  ['forced password change validates cross-fields and clears the real session flag', checkForcedPassword],
]

export const formsTouchScenarios: readonly (readonly [string, (context: FormsContext) => Promise<void>])[] = [
  ['@touch sign-up fields, native taps and submit state work on a narrow screen', checkSignup],
  ['@touch profile editing persists, resets and re-edits after native taps', checkProfileName],
]
