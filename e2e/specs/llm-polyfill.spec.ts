import { test, expect } from '@playwright/test'

test.describe('LLM (Anthropic) polyfill in dashboard iframes', () => {
  let agentSlug: string

  test.beforeEach(async ({ page }) => {
    const createResp = await page.request.post('/api/agents', {
      data: { name: `llm-polyfill-e2e-${Date.now()}` },
    })
    const agent = await createResp.json() as { slug: string }
    agentSlug = agent.slug

    await page.request.post(`/api/agents/${agentSlug}/start`)
  })

  test('polyfill is injected into dashboard HTML', async ({ page, baseURL }) => {
    const dashboardUrl = `${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`
    const response = await page.request.get(dashboardUrl)

    const html = await response.text()
    expect(response.headers()['content-type']).toContain('text/html')
    expect(html).toContain('window.Anthropic')
  })

  test('polyfill provides working Anthropic class', async ({ page, baseURL }) => {
    const dashboardUrl = `${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`
    await page.goto(dashboardUrl)

    const checks = await page.evaluate(() => {
      const Anthropic = (window as any).Anthropic
      if (!Anthropic) return { loaded: false } as any
      const client = new Anthropic()
      return {
        loaded: true,
        name: Anthropic.name,
        hasMessages: !!client.messages,
        hasCreate: typeof client.messages.create === 'function',
        hasStream: typeof client.messages.stream === 'function',
      }
    })

    expect(checks.loaded).toBe(true)
    expect(checks.name).toBe('Anthropic')
    expect(checks.hasMessages).toBe(true)
    expect(checks.hasCreate).toBe(true)
    expect(checks.hasStream).toBe(true)
  })

  test('messages.create() returns error when LLM is not configured', async ({ page, baseURL }) => {
    const dashboardUrl = `${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`
    await page.goto(dashboardUrl)

    const result = await page.evaluate(async () => {
      const Anthropic = (window as any).Anthropic
      if (!Anthropic) return { error: 'Anthropic not defined' }
      const client = new Anthropic()
      try {
        await client.messages.create({
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }],
        })
        return { error: null }
      } catch (err: any) {
        return { error: err.message }
      }
    })

    // In E2E mock mode, LLM is not configured so the proxy returns an error
    expect(result.error).toBeTruthy()
  })
})
