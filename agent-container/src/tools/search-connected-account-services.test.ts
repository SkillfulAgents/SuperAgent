import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadCatalog(platformMode = false, toolkits?: string) {
  vi.stubEnv('COMPOSIO_PLATFORM_MODE', String(platformMode))
  vi.stubEnv('CONNECTED_ACCOUNT_TOOLKITS', toolkits)
  vi.resetModules()
  return import('./search-connected-account-services')
}

describe('connected account service discovery', () => {
  it.each([
    ['Facebook Pages', 'facebook'],
    ['WhatsApp Business', 'whatsapp'],
    ['NotebookLM Enterprise', 'notebook_lm'],
    ['Cal.com', 'cal'],
    ['Hugging Face', 'hugging_face'],
  ])('finds %s by its public name and returns a requestable toolkit', async (name, slug) => {
    const catalog = await loadCatalog()
    const result = await catalog.searchConnectedAccountServicesTool.handler({ search: name }, {})
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining(`${slug} (${name})`) }),
    ])
    expect(catalog.isRequestableToolkit(slug)).toBe(true)
  })

  it('finds account types by category and use case', async () => {
    const { searchConnectedAccountServicesTool } = await loadCatalog()
    const category = await searchConnectedAccountServicesTool.handler({ search: 'Analytics & Data' }, {})
    expect(category.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('google_analytics (Google Analytics)') }),
    ])
    const useCase = await searchConnectedAccountServicesTool.handler({ search: 'transcripts' }, {})
    expect(useCase.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('fathom (Fathom)') }),
    ])
  })

  it.each([false, true])('preserves custom account visibility in platform mode %s', async (platformMode) => {
    const catalog = await loadCatalog(platformMode)
    for (const slug of ['twitter', 'plaid', 'highlevel', 'shopify']) {
      expect(catalog.isRequestableToolkit(slug)).toBe(platformMode)
    }
    for (const slug of ['jira', 'gong', 'pagerduty', 'todoist', 'excel']) {
      expect(catalog.isRequestableToolkit(slug)).toBe(true)
    }
    expect(catalog.isRequestableToolkit('not-a-supported-toolkit')).toBe(false)
  })

  it('limits discovery and account requests to the host-selected provider', async () => {
    const catalog = await loadCatalog(true, 'gmail,github')
    expect(catalog.SERVICES.map((service) => service.slug)).toEqual(['gmail', 'github'])
    expect(catalog.isRequestableToolkit('gmail')).toBe(true)
    expect(catalog.isRequestableToolkit('todoist')).toBe(false)
    expect(catalog.isRequestableToolkit('twitter')).toBe(false)
    const result = await catalog.searchConnectedAccountServicesTool.handler({ search: 'Todoist' }, {})
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('No services found') }),
    ])
  })

  it('treats an explicitly empty host list as no available services', async () => {
    const catalog = await loadCatalog(true, '')
    expect(catalog.SERVICES).toEqual([])
    expect(catalog.isRequestableToolkit('gmail')).toBe(false)
    expect(catalog.isRequestableToolkit('twitter')).toBe(false)
    const result = await catalog.searchConnectedAccountServicesTool.handler({}, {})
    expect(result.content).toEqual([
      { type: 'text', text: 'No connected-account services are available on this host.' },
    ])
  })
})
