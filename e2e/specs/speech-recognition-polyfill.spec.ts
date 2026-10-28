import { test, expect } from '@playwright/test'

test.describe('SpeechRecognition polyfill in dashboard iframes', () => {
  let agentSlug: string

  test.beforeEach(async ({ page }) => {
    // Create agent via API to get a reliable slug
    const createResp = await page.request.post('/api/agents', {
      data: { name: `polyfill-e2e-${Date.now()}` },
    })
    const agent = await createResp.json() as { slug: string }
    agentSlug = agent.slug

    // Start the container via API
    await page.request.post(`/api/agents/${agentSlug}/start`)
  })

  test('polyfill is injected into dashboard HTML', async ({ page, baseURL }) => {
    // Directly fetch the dashboard HTML through the artifact proxy
    // MockContainerClient returns HTML for /artifacts/<slug>/ paths
    const dashboardUrl = `${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`
    const response = await page.request.get(dashboardUrl)

    // Verify the response is HTML with the polyfill injected
    const html = await response.text()
    expect(response.headers()['content-type']).toContain('text/html')
    expect(html).toContain('SuperagentSpeechRecognition')
    expect(html).toContain('window.SpeechRecognition')
    expect(html).toContain('window.webkitSpeechRecognition')
  })

  test('polyfill provides working SpeechRecognition class', async ({ page, baseURL }) => {
    // Navigate directly to the dashboard page
    const dashboardUrl = `${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`
    await page.goto(dashboardUrl)

    // Verify the polyfill installed correctly
    const checks = await page.evaluate(() => {
      const SR = (window as any).SpeechRecognition
      if (!SR) return { loaded: false } as any
      const r = new SR()
      return {
        loaded: true,
        name: SR.name,
        hasWebkit: typeof (window as any).webkitSpeechRecognition === 'function',
        isEventTarget: r instanceof EventTarget,
        hasStart: typeof r.start === 'function',
        hasStop: typeof r.stop === 'function',
        hasAbort: typeof r.abort === 'function',
        defaultContinuous: r.continuous,
        defaultInterimResults: r.interimResults,
      }
    })

    expect(checks.loaded).toBe(true)
    expect(checks.name).toBe('SuperagentSpeechRecognition')
    expect(checks.hasWebkit).toBe(true)
    expect(checks.isEventTarget).toBe(true)
    expect(checks.hasStart).toBe(true)
    expect(checks.hasStop).toBe(true)
    expect(checks.hasAbort).toBe(true)
    expect(checks.defaultContinuous).toBe(false)
    expect(checks.defaultInterimResults).toBe(false)
  })

  test('start() fires service-not-allowed when STT is not configured', async ({ page, baseURL }) => {
    const dashboardUrl = `${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`
    await page.goto(dashboardUrl)

    // Call start() — STT is not configured in E2E mock mode, so error should fire
    const result = await page.evaluate(() => {
      return new Promise<{ error: string; message: string }>((resolve, reject) => {
        const SR = (window as any).SpeechRecognition
        if (!SR) { reject(new Error('SpeechRecognition not defined')); return }
        const r = new SR()
        r.onerror = (event: any) => {
          resolve({ error: event.error, message: event.message })
        }
        // Timeout fallback in case no error fires
        setTimeout(() => reject(new Error('Timed out waiting for error event')), 5000)
        r.start()
      })
    })

    expect(result.error).toBe('service-not-allowed')
  })
})
