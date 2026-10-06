import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { inputManager } from '../input-manager'

describe('requestConnectedAccountTool', () => {
  let originalAccounts: string | undefined

  beforeEach(() => {
    originalAccounts = process.env.CONNECTED_ACCOUNTS
  })

  afterEach(() => {
    if (originalAccounts === undefined) {
      delete process.env.CONNECTED_ACCOUNTS
    } else {
      process.env.CONNECTED_ACCOUNTS = originalAccounts
    }
  })

  async function invokeTool(toolUseId: string, toolkit = 'gmail') {
    const { requestConnectedAccountTool } = await import('./request-connected-account')
    const handler = (requestConnectedAccountTool as any).handler
    inputManager.setCurrentToolUseId(toolUseId)
    return handler({
      toolkit,
      reason: 'Allow access to Gmail to search for the shipping confirmation?',
    }) as Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
  }

  it('parks the pending request as connected_account, not secret', async () => {
    const toolUseId = `ca-test-${Date.now()}-1`
    const resultPromise = invokeTool(toolUseId)

    await vi.waitFor(() => expect(inputManager.hasPending(toolUseId)).toBe(true))
    const entry = inputManager.getAllPending().find((p) => p.toolUseId === toolUseId)
    expect(entry?.inputType).toBe('connected_account')

    inputManager.resolve(toolUseId, 'granted')
    const result = await resultPromise
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('gmail')
  })

  it('keeps the toolkit and reason on the pending metadata', async () => {
    const toolUseId = `ca-test-${Date.now()}-2`
    const resultPromise = invokeTool(toolUseId)

    await vi.waitFor(() => expect(inputManager.hasPending(toolUseId)).toBe(true))
    const entry = inputManager.getAllPending().find((p) => p.toolUseId === toolUseId)
    expect(entry?.metadata).toMatchObject({
      toolkit: 'gmail',
      reason: 'Allow access to Gmail to search for the shipping confirmation?',
    })

    inputManager.resolve(toolUseId, 'granted')
    await resultPromise
  })

  it('returns a declined message when the request is rejected', async () => {
    const toolUseId = `ca-test-${Date.now()}-3`
    const resultPromise = invokeTool(toolUseId)

    await vi.waitFor(() => expect(inputManager.hasPending(toolUseId)).toBe(true))
    inputManager.reject(toolUseId, 'User declined to provide access')

    const result = await resultPromise
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('declined')
  })

  it('rejects a toolkit we do not support without parking a request', async () => {
    const toolUseId = `ca-test-${Date.now()}-4`
    const result = await invokeTool(toolUseId, 'amazon')

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('"amazon" is not supported by us')
    expect(inputManager.hasPending(toolUseId)).toBe(false)
  })

  it('parks a request for an unlisted platform toolkit so an existing account can be assigned', async () => {
    const originalMode = process.env.COMPOSIO_PLATFORM_MODE
    process.env.COMPOSIO_PLATFORM_MODE = 'true'
    try {
      const toolUseId = `ca-test-${Date.now()}-5`
      const resultPromise = invokeTool(toolUseId, 'shopify')

      await vi.waitFor(() => expect(inputManager.hasPending(toolUseId)).toBe(true))
      inputManager.resolve(toolUseId, 'granted')
      const result = await resultPromise
      expect(result.isError).toBeUndefined()
    } finally {
      if (originalMode === undefined) delete process.env.COMPOSIO_PLATFORM_MODE
      else process.env.COMPOSIO_PLATFORM_MODE = originalMode
    }
  })

  it('rejects an unlisted platform toolkit outside platform mode', async () => {
    const toolUseId = `ca-test-${Date.now()}-6`
    const result = await invokeTool(toolUseId, 'shopify')

    expect(result.isError).toBe(true)
    expect(inputManager.hasPending(toolUseId)).toBe(false)
  })
})
