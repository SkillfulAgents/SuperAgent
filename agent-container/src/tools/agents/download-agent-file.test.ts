import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockAuthenticatedHostResponse = vi.fn()
vi.mock('./host-client', async () => {
  const actual = await vi.importActual<typeof import('./host-client')>('./host-client')
  return {
    ...actual,
    authenticatedHostResponse: (...args: unknown[]) => mockAuthenticatedHostResponse(...args),
  }
})

describe('download_agent_file', () => {
  let workspace: string

  beforeEach(async () => {
    mockAuthenticatedHostResponse.mockReset()
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-file-download-'))
  })

  afterEach(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true })
  })

  it('streams binary bytes to a filename safely derived from Content-Disposition', async () => {
    const bytes = Uint8Array.from([0, 255, 1, 128])
    mockAuthenticatedHostResponse.mockResolvedValue(new Response(bytes, {
      headers: { 'Content-Disposition': 'attachment; filename="../../report.bin"' },
    }))
    const { downloadAgentFile } = await import('./download-agent-file')

    const result = await downloadAgentFile({ slug: 'callee', session_id: 'session', delivery_id: 'delivery' }, workspace)

    expect(mockAuthenticatedHostResponse).toHaveBeenCalledWith('download-file', {
      slug: 'callee',
      sessionId: 'session',
      deliveryId: 'delivery',
    })
    expect(result).toEqual({ path: '/workspace/downloads/x-agent/callee/report.bin', bytes: 4 })
    expect(await fs.promises.readFile(path.join(workspace, 'downloads/x-agent/callee/report.bin'))).toEqual(Buffer.from(bytes))
  })

  it('supports RFC 5987 filenames', async () => {
    mockAuthenticatedHostResponse.mockResolvedValue(new Response('data', {
      headers: { 'Content-Disposition': "attachment; filename*=UTF-8''report%20final.csv" },
    }))
    const { downloadAgentFile } = await import('./download-agent-file')

    const result = await downloadAgentFile({ slug: 'callee', session_id: 'session', delivery_id: 'delivery' }, workspace)

    expect(result.path).toBe('/workspace/downloads/x-agent/callee/report final.csv')
  })

  it('uses a fallback filename and preserves both duplicate downloads', async () => {
    mockAuthenticatedHostResponse
      .mockResolvedValueOnce(new Response('first'))
      .mockResolvedValueOnce(new Response('second'))
    const { downloadAgentFile } = await import('./download-agent-file')
    const args = { slug: '../callee', session_id: 'session', delivery_id: 'delivery' }

    const first = await downloadAgentFile(args, workspace)
    const second = await downloadAgentFile(args, workspace)

    expect(first.path).toBe('/workspace/downloads/x-agent/_callee/agent-file-delivery')
    expect(second.path).toBe('/workspace/downloads/x-agent/_callee/agent-file-delivery-1')
    expect(await fs.promises.readFile(path.join(workspace, 'downloads/x-agent/_callee/agent-file-delivery'), 'utf8')).toBe('first')
    expect(await fs.promises.readFile(path.join(workspace, 'downloads/x-agent/_callee/agent-file-delivery-1'), 'utf8')).toBe('second')
  })

  it('cleans partial files when the host response stream fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]))
        controller.error(new Error('connection lost'))
      },
    })
    mockAuthenticatedHostResponse.mockResolvedValue(new Response(body, {
      headers: { 'Content-Disposition': 'attachment; filename="broken.bin"' },
    }))
    const { downloadAgentFile } = await import('./download-agent-file')

    await expect(downloadAgentFile({ slug: 'callee', session_id: 'session', delivery_id: 'delivery' }, workspace))
      .rejects.toThrow('connection lost')
    expect(await fs.promises.readdir(path.join(workspace, 'downloads/x-agent/callee'))).toEqual([])
  })
})
