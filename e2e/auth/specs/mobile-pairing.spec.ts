import { expect } from '@playwright/test'
import { test } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { SettingsPage } from '../pages/settings.page'
import { AppPage } from '../../pages/app.page'

// Serial narrative: sign up → pair via the Settings Mobile tab → drive the
// token lifecycle (redeem, replay, renew, revoke) through the public API.
test.describe.configure({ mode: 'serial' })

const user1 = { name: 'Mona Mobile', email: 'mona@test.com', password: 'password123' }

// Captured across tests.
let deepLink = ''
let pairingToken = ''
let mobileBearer = ''
let mobileRefresh = ''

test.describe('Mobile pairing', () => {
  test('user signs up and the Mobile settings tab is visible', async ({ user1Page }) => {
    const authPage = new AuthPage(user1Page)
    const appPage = new AppPage(user1Page)
    const settingsPage = new SettingsPage(user1Page)

    await authPage.resetToAuthPage()
    await authPage.signUpOrSignIn(user1.name, user1.email, user1.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()

    await settingsPage.open()
    await settingsPage.expectTabVisible('mobile')
  })

  test('minting a pairing code renders the deep link', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)
    await settingsPage.navigateToTab('mobile')

    // Mint happens on click only — no deep link before.
    await expect(user1Page.locator('[data-testid="mobile-pairing-deeplink"]')).not.toBeVisible()
    await user1Page.locator('[data-testid="mobile-pairing-mint"]').click()

    const deepLinkEl = user1Page.locator('[data-testid="mobile-pairing-deeplink"]')
    await expect(deepLinkEl).toBeVisible()
    deepLink = (await deepLinkEl.textContent())?.trim() ?? ''
    expect(deepLink).toMatch(/^gamut:\/\/connect\?v=1&url=.+&token=mp_/)

    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- deepLink shape asserted above
    const url = new URL(deepLink)
    pairingToken = url.searchParams.get('token') ?? ''
    expect(pairingToken).toMatch(/^mp_/)
    expect(url.searchParams.get('v')).toBe('1')
    expect(url.searchParams.get('url')).toBeTruthy()
  })

  test('the pairing token redeems exactly once', async ({ request }) => {
    const redeem = await request.post('/api/auth/mobile/redeem', {
      data: { token: pairingToken, deviceName: 'E2E Phone', platform: 'e2e' },
    })
    expect(redeem.status()).toBe(200)
    const body = await redeem.json()
    expect(body.token).toBeTruthy()
    expect(body.refreshToken).toMatch(/^mr_/)
    expect(body.user.email).toBe(user1.email)
    mobileBearer = body.token
    mobileRefresh = body.refreshToken

    // Replay is refused with a generic 401.
    const replay = await request.post('/api/auth/mobile/redeem', {
      data: { token: pairingToken },
    })
    expect(replay.status()).toBe(401)
  })

  test('the mobile bearer token authenticates API requests', async ({ request }) => {
    const res = await request.get('/api/agents', {
      headers: { authorization: `Bearer ${mobileBearer}` },
    })
    expect(res.status()).toBe(200)
  })

  test('the mobile session renews for a fresh bearer token', async ({ request }) => {
    const oldBearer = mobileBearer
    const oldRefresh = mobileRefresh
    const renew = await request.post('/api/auth/mobile/renew', {
      data: { refreshToken: oldRefresh },
    })
    expect(renew.status()).toBe(200)
    const body = await renew.json()
    expect(body.token).toBeTruthy()
    expect(body.token).not.toBe(oldBearer)
    expect(body.refreshToken).not.toBe(oldRefresh)
    mobileBearer = body.token
    mobileRefresh = body.refreshToken

    const replay = await request.post('/api/auth/mobile/renew', {
      data: { refreshToken: oldRefresh },
    })
    expect(replay.status()).toBe(401)

    const oldAccess = await request.get('/api/agents', {
      headers: { authorization: `Bearer ${oldBearer}` },
    })
    expect(oldAccess.status()).toBe(401)

    const res = await request.get('/api/agents', {
      headers: { authorization: `Bearer ${mobileBearer}` },
    })
    expect(res.status()).toBe(200)
  })

  test('the paired device appears in the devices list', async ({ user1Page }) => {
    // Refresh the list (it was fetched before the device paired).
    await user1Page.locator('[aria-label="Refresh devices"]').click()
    const list = user1Page.locator('[data-testid="mobile-devices-list"]')
    await expect(list).toBeVisible()
    await expect(list.getByText('E2E Phone').first()).toBeVisible()
  })

  test('revoking the device kills its bearer token', async ({ request }) => {
    // Find the current stable device id via the devices endpoint.
    const devicesRes = await request.get('/api/auth/mobile/devices', {
      headers: { authorization: `Bearer ${mobileBearer}` },
    })
    expect(devicesRes.status()).toBe(200)
    const { devices } = await devicesRes.json()
    const current = devices.find((d: { isCurrent: boolean }) => d.isCurrent)
    expect(current).toBeTruthy()

    const revoke = await request.delete(`/api/auth/mobile/devices/${current.id}`, {
      headers: { authorization: `Bearer ${mobileBearer}` },
    })
    expect(revoke.status()).toBe(200)

    const after = await request.get('/api/agents', {
      headers: { authorization: `Bearer ${mobileBearer}` },
    })
    expect(after.status()).toBe(401)
  })

  test('unauthenticated pairing-token mint is refused', async ({ request }) => {
    const res = await request.post('/api/auth/mobile/pairing-token')
    expect(res.status()).toBe(401)
  })
})
