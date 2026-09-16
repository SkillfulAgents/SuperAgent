import { createHash } from 'crypto'
import { Readable } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openWorkspaceFile } = vi.hoisted(() => ({ openWorkspaceFile: vi.fn() }))

vi.mock('../workspace-file-transfer', () => ({ openWorkspaceFile }))

import { deliverFileTool } from './deliver-file'

describe('deliver_file integrity metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records the digest of the bytes read at delivery time', async () => {
    const bytes = Buffer.from([0, 255, 1, 128])
    openWorkspaceFile.mockResolvedValue({
      relativePath: 'output.bin',
      size: bytes.length,
      stream: Readable.from(bytes),
    })

    const result = await (deliverFileTool as unknown as {
      handler: (args: { filePath: string }) => Promise<{ content: Array<{ text: string }> }>
    }).handler({ filePath: '/workspace/output.bin' })

    expect(result.content[0].text).toContain(`Delivered: ${JSON.stringify({
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })}`)
  })
})
