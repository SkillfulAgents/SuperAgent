import { createHash } from 'crypto'
import { Readable } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openWorkspaceFile } = vi.hoisted(() => ({ openWorkspaceFile: vi.fn() }))

vi.mock('../workspace-file-transfer', async (importOriginal) => ({
  ...await importOriginal<typeof import('../workspace-file-transfer')>(), openWorkspaceFile,
}))
import { WorkspaceFileError } from '../workspace-file-transfer'

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

it.each([
  [new WorkspaceFileError('Path is not a regular file', 400), 'not a regular file'],
  [new WorkspaceFileError('File resolves outside /workspace', 403), 'outside /workspace'],
  [new WorkspaceFileError('File not found', 404), 'File not found at'],
])('preserves actionable file errors: %s', async (error, message) => {
  openWorkspaceFile.mockRejectedValueOnce(error)
  const result = await deliverFileTool.handler({ filePath: '/workspace/file' }, {})
  expect(result.isError).toBe(true)
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining(message) })
})
it('reports mid-read changes without calling the file missing', async () => {
  openWorkspaceFile.mockResolvedValueOnce({ size: 10, stream: Readable.from('short') })
  const result = await deliverFileTool.handler({ filePath: '/workspace/file' }, {})
  expect(result.isError).toBe(true)
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('File changed') })
})
