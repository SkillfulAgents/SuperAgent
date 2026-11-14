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

const host = vi.hoisted(() => ({ answer: { text: null as string | null } as { text: string | null } | Error }))
vi.mock('./chat/host-client', () => ({
  callChatHost: async () => { if (host.answer instanceof Error) throw host.answer; return host.answer },
}))

import { makeDeliverFileTool } from './deliver-file'

const deliverFileTool = makeDeliverFileTool(() => null)

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

describe('deliver_file in a chat session', () => {
  const inChat = makeDeliverFileTool(() => 'session-1')
  beforeEach(async () => {
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deliver-file-'))
    await fs.promises.writeFile(path.join(workspace, 'big.bin'), 'x')
  })
  afterEach(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true })
  })
  const text = async () => ((await inChat.handler({ filePath: '/workspace/big.bin' }, {})).content[0] as { text: string }).text

  it('says what the chat did with the file, not that it was delivered', async () => {
    host.answer = { text: 'was NOT sent to Telegram: 413: Request Entity Too Large. Tell the user.' }
    expect(await text()).toMatch(/^File "big.bin" \(1 bytes\) was NOT sent to Telegram: 413/)
  })

  it('does not claim chat delivery when the app does not answer, and says the file is in the app', async () => {
    host.answer = new Error('network down')
    expect(await text()).toMatch(/^File "big.bin" \(1 bytes\) is in the app\. A connected chat may not have received it: the app did not confirm\. Do not send it again/)
  })

  it('says the file was delivered when the session has no chat', async () => {
    host.answer = { text: null }
    expect(await text()).toMatch(/^File "big.bin" \(1 bytes\) has been delivered to the user\./)
  })
})
