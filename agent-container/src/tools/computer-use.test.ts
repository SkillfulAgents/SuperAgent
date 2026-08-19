import { afterEach, describe, expect, it, vi } from 'vitest'
import { inputManager } from '../input-manager'
import {
  COMPUTER_USE_GUIDANCE_HINT,
  computerAppsTool,
  computerGrabTool,
  computerSnapshotTool,
  computerWindowsTool,
} from './computer-use'

afterEach(() => {
  vi.restoreAllMocks()
})

function mockComputerUseOutput(output: string): void {
  vi.spyOn(inputManager, 'consumeCurrentToolUseId').mockReturnValue('tool-use-1')
  vi.spyOn(inputManager, 'createPendingWithType').mockResolvedValue(output)
}

describe('computer-use guidance', () => {
  it.each([
    ['apps', computerAppsTool, {}],
    ['windows', computerWindowsTool, {}],
    ['grab', computerGrabTool, { ref: '@w1' }],
  ])('returns the guide hint from %s', async (_name, tool, args) => {
    mockComputerUseOutput('command result')

    const result = await (tool as any).handler(args)

    expect(result.content[0].text).toContain(COMPUTER_USE_GUIDANCE_HINT)
  })

  it('does not repeat the guide hint on every interaction tool', async () => {
    mockComputerUseOutput('snapshot result')

    const result = await (computerSnapshotTool as any).handler({})

    expect(result.content[0].text).not.toContain(COMPUTER_USE_GUIDANCE_HINT)
  })
})
