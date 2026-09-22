import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let workspace: string
vi.mock('../workspace-file-transfer', async (importOriginal) => {
  const original = await importOriginal<typeof import('../workspace-file-transfer')>()
  return {
    ...original,
    resolveWorkspaceRegularFile: (filePath: string) => original.resolveWorkspaceRegularFile(filePath, workspace),
    openWorkspaceFile: (filePath: string) => original.openWorkspaceFile(filePath, workspace),
  }
})

import { deliverFileTool } from './deliver-file'

describe('deliver_file metadata-only delivery', () => {
  beforeEach(async () => {
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deliver-file-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.promises.rm(workspace, { recursive: true, force: true })
  })

  it.each([0, 3 * 1024 ** 3])('delivers a %i-byte file without opening or reading its contents', async (size) => {
    const filePath = path.join(workspace, 'report.bin')
    await fs.promises.writeFile(filePath, '')
    // Sparse file: exercises real multi-GB metadata without allocating its bytes.
    await fs.promises.truncate(filePath, size)
    const open = vi.spyOn(fs.promises, 'open').mockRejectedValue(new Error('File content must not be opened'))
    const read = vi.spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('File content must not be read'))
    const result = await deliverFileTool.handler({ filePath: '/workspace/report.bin' }, {})

    expect(result.isError).not.toBe(true)
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`Delivered: ${JSON.stringify({ sizeBytes: size })}`) })
    expect(open).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    ['/workspace/directory', 'not a regular file'],
    ['/etc/passwd', 'outside /workspace'],
    ['/workspace/escape', 'outside /workspace'],
    ['/workspace/missing', 'File not found at'],
  ])('preserves actionable errors for %s', async (filePath, message) => {
    await fs.promises.mkdir(path.join(workspace, 'directory'))
    await fs.promises.symlink(os.tmpdir(), path.join(workspace, 'escape'))
    const result = await deliverFileTool.handler({ filePath }, {})
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(message) })
  })
})
