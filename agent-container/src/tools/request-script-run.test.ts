import { describe, it, expect, vi, beforeEach } from 'vitest'
import { inputManager } from '../input-manager'

describe('requestScriptRunTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns error when no toolUseId is available', async () => {
    // Ensure no toolUseId is set
    inputManager.consumeCurrentToolUseId()

    // Dynamically import to get the tool handler
    const { requestScriptRunTool } = await import('./request-script-run')
    const handler = (requestScriptRunTool as any).handler

    const result = await handler({
      script: 'sw_vers',
      explanation: 'Check version',
      scriptType: 'shell',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('no tool use ID available')
  })

  it('calls createPendingWithType and returns resolved output', async () => {
    const toolUseId = `script-test-${Date.now()}-1`
    inputManager.setCurrentToolUseId(toolUseId)

    // Pre-resolve so createPendingWithType returns immediately
    inputManager.resolve(toolUseId, 'Exit code: 0\n\nstdout:\nProductName: macOS')

    const { requestScriptRunTool } = await import('./request-script-run')
    const handler = (requestScriptRunTool as any).handler

    const result = await handler({
      script: 'sw_vers',
      explanation: 'Check macOS version',
      scriptType: 'shell',
    })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('ProductName: macOS')
  })

  it('returns fallback message when output is empty', async () => {
    const toolUseId = `script-test-${Date.now()}-2`
    inputManager.setCurrentToolUseId(toolUseId)

    // Resolve with empty string
    inputManager.resolve(toolUseId, '')

    const { requestScriptRunTool } = await import('./request-script-run')
    const handler = (requestScriptRunTool as any).handler

    const result = await handler({
      script: 'echo',
      explanation: 'Empty output',
      scriptType: 'shell',
    })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('Script executed successfully (no output).')
  })

  it('returns error content when request is rejected', async () => {
    const toolUseId = `script-test-${Date.now()}-3`
    inputManager.setCurrentToolUseId(toolUseId)

    // Pre-reject
    inputManager.reject(toolUseId, 'User denied script execution')

    const { requestScriptRunTool } = await import('./request-script-run')
    const handler = (requestScriptRunTool as any).handler

    const result = await handler({
      script: 'rm -rf /',
      explanation: 'Dangerous',
      scriptType: 'shell',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('User denied script execution')
  })
})
