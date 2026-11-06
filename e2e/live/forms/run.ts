/**
 * Built, sandboxed Electron -> real auth deployment -> profile forms.
 * CI supplies the desktop and API builds; this harness never builds.
 * Only the platform directory and grant issuer are stubbed. The deployment
 * verifies signed grants and creates real sessions, credentials and user rows.
 *
 * E2E_MOCK=true xvfb-run --auto-servernum npx tsx e2e/live/forms/run.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron, expect, request, type APIRequestContext, type ElectronApplication, type Page } from '@playwright/test'
import type { WebContents, WebPreferences } from 'electron'
import { checkProfileNameForm, checkProfilePasswordForm, type FormsContext, type FormsUser } from '../../helpers/forms-upgrade'
import { startStubPlatform } from '../cloud-electron/stub-platform.mjs'
import { authResponseSchema, cloudTargetSchema, policySchema, seedSettingsSchema } from './schema'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const artifacts = join(repoRoot, 'test-results/electron-forms')
const owner: FormsUser = { name: 'Forms Desktop Owner', email: 'forms-desktop@e2e.test', password: 'Forms-Original-2026!' }
const admin = { name: 'Forms Desktop Admin', email: 'forms-desktop-admin@e2e.test', password: 'Forms-Admin-2026!' }
const orgId = 'org_11111111-1111-1111-1111-111111111111'
const platformToken = 'plat_sa_forms_deadbeefdeadbeefdeadbeefdeadbeef'

async function unusedPort() {
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const address = socket.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a deployment port')
  await new Promise<void>((done, reject) => socket.close(error => error ? reject(error) : done()))
  return address.port
}

async function closeChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  const kill = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    child.kill('SIGTERM')
    await exited
  } finally {
    clearTimeout(kill)
  }
}

async function closeApp(app: ElectronApplication) {
  const child = app.process()
  const kill = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    await app.close()
  } finally {
    clearTimeout(kill)
    await closeChild(child)
  }
}

async function main() {
  const entry = join(repoRoot, 'dist/main/index.js')
  const renderer = join(repoRoot, 'dist/renderer/index.html')
  const server = join(repoRoot, 'dist/web/server.mjs')
  if (![entry, renderer, server].every(existsSync)) {
    throw new Error('Missing desktop/API build. Run after the CI desktop/API build; this harness does not build locally.')
  }
  mkdirSync(artifacts, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'electron-forms-'))
  const deploymentData = join(scratch, 'deployment')
  const appData = join(scratch, 'desktop')
  const port = await unusedPort()
  const deploymentUrl = `http://127.0.0.1:${port}`
  const contexts: APIRequestContext[] = []
  const logs: string[] = []
  const pageErrors: string[] = []
  const failures: unknown[] = []
  let app: ElectronApplication | undefined
  let page: Page | undefined
  let deployment: ChildProcess | undefined
  let traceStarted = false
  let platform: Awaited<ReturnType<typeof startStubPlatform>> | undefined
  let restorePolicy: (() => Promise<void>) | undefined

  async function startDeployment(withPlatform: boolean) {
    if (deployment) await closeChild(deployment)
    const label = withPlatform ? 'cloud' : 'bootstrap'
    const child = spawn(process.execPath, [server], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test', AUTH_MODE: 'true', E2E_MOCK: 'true',
        PORT: String(port), HOST: '127.0.0.1', TRUSTED_ORIGINS: deploymentUrl,
        SUPERAGENT_DATA_DIR: deploymentData,
        BETTER_AUTH_SECRET: 'forms-ci-secret-0123456789abcdef0123456789abcdef',
        PLATFORM_TOKEN: withPlatform ? platform!.deploymentPlatformToken : '',
        AUTH_PROVIDERS_JSON: withPlatform ? platform!.deploymentAuthProviders : '[]',
        PLATFORM_BASE_URL: '', PLATFORM_PROXY_URL: '', PLATFORM_AUTH_ISSUER_URL: '',
        ANTHROPIC_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    deployment = child
    let spawnError: Error | undefined
    child.on('error', error => { spawnError = error })
    child.stdout?.on('data', chunk => logs.push(`[${label}] ${String(chunk)}`))
    child.stderr?.on('data', chunk => logs.push(`[${label}] ${String(chunk)}`))
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Deployment exited before readiness (${child.exitCode}/${child.signalCode})`)
      try {
        const response = await fetch(`${deploymentUrl}/api/auth-config`, { signal: AbortSignal.timeout(1_500) })
        if (response.ok) return
      } catch { /* The isolated deployment has not finished binding yet. */ }
      await new Promise(done => setTimeout(done, 150))
    }
    throw new Error(`Timed out waiting for ${label} deployment`)
  }

  async function newRequest() {
    const context = await request.newContext({ extraHTTPHeaders: { Origin: deploymentUrl } })
    contexts.push(context)
    return context
  }

  async function cleanup(label: string, action: () => unknown | Promise<unknown>) {
    try {
      await action()
    } catch (error) {
      failures.push(new Error(`${label} failed`, { cause: error }))
    }
  }

  try {
    mkdirSync(deploymentData, { recursive: true })
    const seed = seedSettingsSchema.parse({
      app: { setupCompleted: true, showMenuBarIcon: false },
      container: { containerRunner: 'docker' }, shareAnalytics: false,
      auth: { signupMode: 'open', allowLocalAuth: true, requireAdminApproval: false, passwordMinLength: 8, passwordRequireComplexity: false, maxConcurrentSessions: 50 },
    })
    writeFileSync(join(deploymentData, 'settings.json'), JSON.stringify(seed), { mode: 0o600 })
    await startDeployment(false)
    const adminRequest = await newRequest()
    const authenticatedRequest = await newRequest()
    for (const [context, user] of [[adminRequest, admin], [authenticatedRequest, owner]] as const) {
      const signup = await context.post(`${deploymentUrl}/api/auth/sign-up/email`, { data: user })
      expect(signup.ok(), `Seed real credential account for ${user.email}`).toBe(true)
      const saved = authResponseSchema.parse(await signup.json())
      if (user === owner) owner.id = saved.user.id
    }
    expect((await authenticatedRequest.put(`${deploymentUrl}/api/user-settings`, { data: { setupCompleted: true } })).ok()).toBe(true)
    const platformOptions = { deploymentUrl, orgId, email: owner.email, platformToken, port: 0 }
    platform = await startStubPlatform(platformOptions)
    await startDeployment(true)
    const probe = await adminRequest.post(`${deploymentUrl}/api/auth/token/exchange`, {
      form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'bogus' },
    })
    expect(probe.status(), 'Real token exchange must reject an invalid signed grant').toBe(400)
    const settingsResponse = await adminRequest.get(`${deploymentUrl}/api/settings`)
    expect(settingsResponse.ok()).toBe(true)
    const before = policySchema.parse(await settingsResponse.json())
    restorePolicy = async () => {
      const response = await adminRequest.put(`${deploymentUrl}/api/settings`, { data: { auth: before.auth } })
      expect(response.ok(), 'Restore deployment password policy').toBe(true)
    }

    // Configure the existing cloud fixture before importing its env snapshot.
    // This seeds a synthetic linked platform account; discovery and signed
    // grant exchange still run through the real application services at boot.
    Object.assign(process.env, {
      LIVE_AUTH_ISSUER_URL: platform.url, LIVE_PROXY_URL: platform.url,
      LIVE_DEPLOYMENT_URL: deploymentUrl, LIVE_PLATFORM_TOKEN: platformToken,
      LIVE_ORG_ID: orgId, LIVE_EMAIL: owner.email,
    })
    const { seedDataDir } = await import('../cloud-electron/harness.mjs')
    seedDataDir(appData, seedSettingsSchema.parse({
      app: { setupCompleted: true, showMenuBarIcon: false },
      container: { containerRunner: 'docker' }, shareAnalytics: false,
    }))
    app = await _electron.launch({
      args: [entry], cwd: repoRoot, timeout: 60_000,
      env: {
        ...process.env,
        SUPERAGENT_DATA_DIR: appData, SUPERAGENT_DISABLE_SINGLE_INSTANCE: '1',
        XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
        E2E_MOCK: 'true', AUTH_MODE: 'false', ELECTRON_RENDERER_URL: '',
        PLATFORM_BASE_URL: '', PLATFORM_TOKEN: '', AUTH_PROVIDERS_JSON: '[]',
        PLATFORM_PROXY_URL: platform.url, PLATFORM_AUTH_ISSUER_URL: platform.url,
      },
    })
    app.process().stdout?.on('data', chunk => logs.push(`[electron] ${String(chunk)}`))
    app.process().stderr?.on('data', chunk => logs.push(`[electron] ${String(chunk)}`))
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    traceStarted = true
    await expect.poll(() => app!.windows().find(window => window.url().includes('/renderer/index.html'))?.url(), { timeout: 60_000 }).toBeTruthy()
    page = app.windows().find(window => window.url().includes('/renderer/index.html'))!
    page.setDefaultTimeout(30_000)
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('crash', () => pageErrors.push('Electron renderer crashed'))
    page.on('console', message => {
      if (message.type() === 'warning' || message.type() === 'error') logs.push(message.text())
    })
    expect(page.url()).toMatch(/^file:\/\//)
    expect(fileURLToPath(page.url().split('#')[0])).toBe(renderer)
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/index.html'))
      if (!window) throw new Error('Main Electron window is missing')
      window.setSize(1280, 900)
      window.show()
      window.focus()
      const contents = window.webContents as WebContents & { getLastWebPreferences(): WebPreferences | null }
      const prefs = contents.getLastWebPreferences()
      if (!prefs) throw new Error('Renderer web preferences are unavailable')
      return { contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox }
    })
    expect(preferences).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true })
    await expect(page.getByTestId('target-option-cloud')).toBeVisible({ timeout: 90_000 })
    await page.getByTestId('target-option-cloud').click()
    await expect(page.locator('html')).toHaveAttribute('data-api-target', 'cloud', { timeout: 90_000 })
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 60_000 })
    const target = cloudTargetSchema.parse(await page.evaluate(() => window.electronAPI!.getApiTarget!()))
    expect(target.deploymentUrl).toBe(deploymentUrl)
    expect(new URL(target.baseUrl).hostname).toBe('localhost')
    expect(new URL(target.baseUrl).pathname).toMatch(/^\/cloud\/[^/]+$/)
    expect(platform.grantsMinted).toBeGreaterThan(0)
    const identity = authResponseSchema.parse(await page.evaluate(async base => {
      const response = await fetch(`${base}/api/auth/get-session`)
      if (!response.ok) throw new Error(`Cloud session lookup failed: ${response.status}`)
      return response.json()
    }, target.baseUrl))
    expect(identity.user.id).toBe(owner.id)
    expect(identity.user.email).toBe(owner.email)
    console.log('PASS built file renderer, sandbox/preload and real discovery/grant/exchange into the existing credential account')

    const rendererUrl = pathToFileURL(renderer).href
    const context: FormsContext = {
      page, apiBaseUrl: deploymentUrl, adminRequest, authenticatedRequest, runtime: 'electron',
      navigate: async route => {
        await page!.goto(`${rendererUrl}#${route}`)
        await page!.reload()
      },
      reauthenticate: async user => {
        const fresh = await newRequest()
        const oldPassword = await fresh.post(`${deploymentUrl}/api/auth/sign-in/email`, { data: { email: user.email, password: owner.password } })
        expect(oldPassword.status(), 'Previous password no longer authenticates').toBe(401)
        const login = await fresh.post(`${deploymentUrl}/api/auth/sign-in/email`, { data: user })
        expect(login.ok(), 'Changed password authenticates against the real deployment').toBe(true)
        expect(authResponseSchema.parse(await login.json()).user.id).toBe(owner.id)
      },
      captureFailure: async () => {
        await page!.screenshot({ path: join(artifacts, 'failed-before-cleanup.png'), fullPage: true })
      },
    }
    await checkProfileNameForm(context)
    expect(pageErrors).toEqual([])
    console.log('PASS profile name validation, failed/delayed save, pending edit protection, dirty reset, remount and persistence')
    await checkProfilePasswordForm(context, owner)
    expect(pageErrors).toEqual([])
    console.log('PASS password policy arrival, mismatch, cancel/reopen, wrong-password recovery, one pending submit and real credential change')
    await page.screenshot({ path: join(artifacts, 'completed.png'), fullPage: true })
    console.log('PASS built Electron forms completed without renderer errors')
  } catch (error) {
    failures.push(error)
    console.error(logs.join('\n').slice(-12_000))
    if (page && !page.isClosed()) {
      try {
        await page.screenshot({ path: join(artifacts, 'failed.png'), fullPage: true })
      } catch (captureError) {
        failures.push(new Error('Failure screenshot could not be captured', { cause: captureError }))
      }
    }
  } finally {
    // Every cleanup gets an attempt and the original scenario failure remains
    // first, even when trace persistence or process shutdown also fails.
    await cleanup('Restore policy', async () => restorePolicy?.())
    if (app) {
      if (traceStarted) await cleanup('Save trace', () => app!.context().tracing.stop({ path: join(artifacts, 'trace.zip') }))
      await cleanup('Close Electron', () => closeApp(app!))
    }
    for (const context of contexts) await cleanup('Dispose API context', () => context.dispose())
    if (deployment) await cleanup('Stop deployment', () => closeChild(deployment!))
    if (platform) await cleanup('Stop platform fixture', () => platform!.close())
    await cleanup('Save process log', () => writeFileSync(join(artifacts, 'process.log'), logs.join('\n')))
    await cleanup('Remove isolated data', () => rmSync(scratch, { recursive: true, force: true }))
  }
  if (failures.length) throw new AggregateError(failures, 'Electron forms validation or cleanup failed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
