import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { inputManager } from '../input-manager'
import {
  COMPUTER_USE_GUIDANCE_HINT,
  computerAppsTool,
  computerGrabTool,
  computerSnapshotTool,
  computerScreenshotTool,
  computerWindowsTool,
} from './computer-use'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('computer screenshot delivery', () => {
  it('converts a large JPEG to PNG and retains the original screen coordinates', async () => {
    const input = await sharp({
      create: { width: 2560, height: 1440, channels: 3, background: '#123456' },
    }).jpeg().toBuffer()
    mockComputerUseOutput(JSON.stringify({
      type: 'screenshot', base64: input.toString('base64'), media_type: 'image/jpeg', width: 2560, height: 1440,
    }))

    const result = await (computerScreenshotTool as any).handler({})

    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(await sharp(Buffer.from(result.content[0].data, 'base64')).metadata())
      .toMatchObject({ format: 'png', width: 1461, height: 822 })
    expect(result.content[1].text).toContain('actual screen resolution is 2560x1440')
    expect(result.content[1].text).toContain('use the original resolution coordinates')
  })

  it('passes through a small JPEG without a misleading resize warning', async () => {
    const input = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#123456' },
    }).jpeg().toBuffer()
    mockComputerUseOutput(JSON.stringify({
      type: 'screenshot', base64: input.toString('base64'), media_type: 'image/jpeg', width: 640, height: 480,
    }))

    const result = await (computerScreenshotTool as any).handler({})

    expect(result.content).toEqual([{ type: 'image', data: input.toString('base64'), mimeType: 'image/jpeg' }])
  })
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
