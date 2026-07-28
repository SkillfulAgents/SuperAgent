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

  async function invokeTool(toolUseId: string) {
    const { requestConnectedAccountTool } = await import('./request-connected-account')
    const handler = (requestConnectedAccountTool as any).handler
    inputManager.setCurrentToolUseId(toolUseId)
    return handler({
      toolkit: 'gmail',
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
})
