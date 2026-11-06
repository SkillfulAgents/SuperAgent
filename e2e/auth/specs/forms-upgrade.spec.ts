import { test, expect, type Request } from '@playwright/test'
import { formsUpgradeScenarios, formsTouchScenarios, initializeFormsAdmin, type FormsContext } from '../../helpers/forms-upgrade'

test.describe.configure({ mode: 'default' })

for (const [name, scenario] of [...formsUpgradeScenarios, ...formsTouchScenarios]) {
  test(name, async ({ page, request, baseURL, isMobile, browserName }, testInfo) => {
    const authRoot = `${baseURL!.replace(/\/$/, '')}/api/auth`
    let sequence = 0
    const errors: { order: number; name: string; message: string }[] = []
    const nativeErrors: { kind: string; message: string }[] = []
    const forced = name.startsWith('forced password change')
    let passwordChangedAt: number | undefined
    let reload: { request: Request; started: number; committed?: number } | undefined
    page.on('pageerror', (error) => errors.push({ order: ++sequence, name: error.name, message: error.message }))
    page.on('response', (response) => {
      if (forced && response.request().method() === 'POST' && response.url() === `${authRoot}/change-password` && response.status() === 200) passwordChangedAt = ++sequence
    })
    page.on('request', (request) => {
      if (passwordChangedAt && !reload && request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === page.url()) reload = { request, started: ++sequence }
    })
    page.on('framenavigated', (frame) => {
      if (reload && !reload.committed && frame === page.mainFrame() && frame.url() === reload.request.url()) reload.committed = ++sequence
    })
    // WebKit's protocol also reports native failed-fetch console diagnostics as
    // pageerror. Independently retain actual window errors and rejected promises.
    await page.exposeFunction('__formsNativeError', (kind: string, message: string) => { nativeErrors.push({ kind, message }) })
    await page.addInitScript(() => {
      const report = (kind: string, message: string) => {
        void (window as unknown as { __formsNativeError: (kind: string, message: string) => Promise<void> }).__formsNativeError(kind, message)
      }
      window.addEventListener('error', (event) => report('error', event.message))
      window.addEventListener('unhandledrejection', (event) => report('unhandledrejection', String(event.reason)))
    })
    await initializeFormsAdmin(request, baseURL!)
    const context: FormsContext = {
      page,
      adminRequest: request,
      apiBaseUrl: baseURL!,
      navigate: (route) => page.goto(route),
      runtime: 'web',
      touch: isMobile,
      captureFailure: async () => {
        await testInfo.attach('forms-before-cleanup', { body: await page.screenshot({ fullPage: true, timeout: 5000 }), contentType: 'image/png' })
      },
    }
    let scenarioFailure: unknown
    try { await scenario(context) } catch (error) { scenarioFailure = error }
    // Old and new form libraries both reproduce this exact native WebKit
    // diagnostic while the forced-password page unloads. Only that document's
    // request→commit interval is classified; the helper also requires a fresh
    // renderer session with the same user, cleared flag, and mounted Account UI.
    const nativeReloadDiagnostics = errors.filter((error) => !scenarioFailure && !nativeErrors.length && browserName === 'webkit' && forced && passwordChangedAt && reload?.committed && error.order > reload.started && error.order < reload.committed && error.name === 'Fetch API cannot load http' && error.message === `${authRoot.replace(/^https?:\/\//, '/')}/get-session due to access control checks.`)
    if (errors.length || nativeErrors.length) {
      try {
        await testInfo.attach('forms-browser-diagnostics', {
          body: JSON.stringify({ scenarioCompleted: !scenarioFailure, errors, nativeErrors, nativeReloadDiagnostics, passwordChangedAt, reload: reload && { url: reload.request.url(), started: reload.started, committed: reload.committed } }, null, 2),
          contentType: 'application/json',
        })
      } catch (attachmentError) {
        if (!scenarioFailure) throw attachmentError
        throw new AggregateError([scenarioFailure, attachmentError], `Form scenario failed: ${scenarioFailure instanceof Error ? scenarioFailure.message : String(scenarioFailure)}; diagnostic attachment failed`)
      }
    }
    if (scenarioFailure) throw scenarioFailure
    if (nativeReloadDiagnostics.length) testInfo.annotations.push({ type: 'native-webkit-reload-diagnostic', description: 'Exact get-session unload diagnostic reproduced with both dependency versions; fresh renderer session and Account UI verified.' })
    expect(nativeErrors, 'Actual window errors or unhandled rejections').toEqual([])
    expect(errors.filter((error) => !nativeReloadDiagnostics.includes(error)), 'Unexpected renderer errors').toEqual([])
  })
}
