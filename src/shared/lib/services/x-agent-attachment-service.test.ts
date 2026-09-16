import { describe, expect, it, vi } from 'vitest'
import type { ContainerClient } from '@shared/lib/container/types'
import {
  normalizeXAgentAttachmentPaths,
  transferXAgentAttachments,
  XAgentAttachmentError,
} from './x-agent-attachment-service'
import { MAX_X_AGENT_ATTACHMENT_BYTES } from './x-agent-attachment-schema'

function client(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>): ContainerClient {
  return { fetch: vi.fn(fetchImpl) } as unknown as ContainerClient
}

async function requestBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer())
}

describe('normalizeXAgentAttachmentPaths', () => {
  it('normalizes relative and absolute workspace paths', () => {
    expect(normalizeXAgentAttachmentPaths(['reports/a.txt', '/workspace/data/b.csv']))
      .toEqual(['/workspace/reports/a.txt', '/workspace/data/b.csv'])
  })

  it.each([
    '',
    '.',
    '/workspace',
    '../outside',
    'folder/../../outside',
    '..\\outside',
    '/workspace/../outside',
    '/workspace-sibling/file',
    '/etc/passwd',
    'C:\\outside',
    'bad\0path',
  ])('rejects unsafe path %j', (candidate) => {
    expect(() => normalizeXAgentAttachmentPaths([candidate])).toThrow()
  })

  it('rejects more than ten attachments', () => {
    expect(() => normalizeXAgentAttachmentPaths(Array.from({ length: 11 }, (_, i) => `file-${i}`)))
      .toThrow()
  })
})

describe('transferXAgentAttachments', () => {
  it('streams exact binary bytes to isolated collision-free target paths', async () => {
    const first = Uint8Array.from([0, 255, 128, 1])
    const second = Uint8Array.from([2, 3])
    const source = client(async (filePath) => {
      const bytes = filePath.includes('/a/') ? first : second
      return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } })
    })
    const uploads: Array<{ path: string; bytes: Uint8Array }> = []
    const target = client(async (filePath, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      uploads.push({ path: filePath, bytes: await requestBytes(init?.body) })
      return Response.json({ success: true })
    })

    const result = await transferXAgentAttachments({
      sourceClient: source,
      targetClient: target,
      sourcePaths: ['/workspace/a/report.bin', '/workspace/b/report.bin'],
      transferId: 'transfer-id',
    })

    expect(result.attachments.map((item) => item.targetPath)).toEqual([
      '/workspace/uploads/x-agent/transfer-id/0/report.bin',
      '/workspace/uploads/x-agent/transfer-id/1/report.bin',
    ])
    expect(uploads).toHaveLength(2)
    expect(uploads[0].bytes).toEqual(first)
    expect(uploads[1].bytes).toEqual(second)
  })

  it('encodes every source and destination path segment', async () => {
    const source = client(async () => new Response('x', { headers: { 'Content-Length': '1' } }))
    const target = client(async () => Response.json({ success: true }))

    await transferXAgentAttachments({
      sourceClient: source,
      targetClient: target,
      sourcePaths: ['/workspace/a folder/hash#query?.txt'],
      transferId: 'id',
    })

    expect(source.fetch).toHaveBeenCalledWith(
      '/workspace-files/content/a%20folder/hash%23query%3F.txt',
      expect.any(Object),
    )
    expect(target.fetch).toHaveBeenCalledWith(
      '/workspace-files/upload/uploads/x-agent/id/0/hash_query_.txt',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('does not upload when the source is missing', async () => {
    const source = client(async () => Response.json({ error: 'File not found' }, { status: 404 }))
    const target = client(async () => new Response(null, { status: 204 }))

    await expect(transferXAgentAttachments({
      sourceClient: source,
      targetClient: target,
      sourcePaths: ['missing.bin'],
      transferId: 'id',
    })).rejects.toMatchObject({ status: 404 })
    expect(target.fetch).toHaveBeenCalledTimes(1)
    expect(target.fetch).toHaveBeenCalledWith('/workspace-files/delete/uploads/x-agent/id', { method: 'DELETE' })
  })

  it('rejects a short or growing source stream and cleans the transfer directory', async () => {
    const source = client(async () => new Response(Uint8Array.from([1, 2]), {
      headers: { 'Content-Length': '3' },
    }))
    const target = client(async (filePath, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      await requestBytes(init?.body)
      return Response.json({ success: true })
    })

    await expect(transferXAgentAttachments({
      sourceClient: source,
      targetClient: target,
      sourcePaths: ['changing.bin'],
      transferId: 'id',
    })).rejects.toBeInstanceOf(XAgentAttachmentError)
    expect(target.fetch).toHaveBeenLastCalledWith('/workspace-files/delete/uploads/x-agent/id', { method: 'DELETE' })
  })

  it('rejects a growing source stream and cleans the transfer directory', async () => {
    const source = client(async () => new Response(Uint8Array.from([1, 2, 3]), {
      headers: { 'Content-Length': '2' },
    }))
    const target = client(async (_filePath, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      await requestBytes(init?.body)
      return Response.json({ success: true })
    })

    await expect(transferXAgentAttachments({
      sourceClient: source,
      targetClient: target,
      sourcePaths: ['growing.bin'],
      transferId: 'id',
    })).rejects.toBeInstanceOf(XAgentAttachmentError)
    expect(target.fetch).toHaveBeenLastCalledWith('/workspace-files/delete/uploads/x-agent/id', { method: 'DELETE' })
  })

  it('cancels an oversized source response before rejecting it', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const source = client(async () => new Response(body, {
      headers: { 'Content-Length': String(MAX_X_AGENT_ATTACHMENT_BYTES + 1) },
    }))
    const target = client(async () => new Response(null, { status: 204 }))

    await expect(transferXAgentAttachments({
      sourceClient: source,
      targetClient: target,
      sourcePaths: ['oversized.bin'],
      transferId: 'id',
    })).rejects.toMatchObject({ status: 413 })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cleans completed files when a later upload fails', async () => {
    const source = client(async () => new Response('x', { headers: { 'Content-Length': '1' } }))
    let uploads = 0
    const target = client(async (_filePath, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      uploads += 1
      return uploads === 1 ? Response.json({ success: true }) : Response.json({ error: 'disk full' }, { status: 507 })
    })

    await expect(transferXAgentAttachments({
      sourceClient: source,
      targetClient: target,
      sourcePaths: ['one.bin', 'two.bin'],
      transferId: 'id',
    })).rejects.toThrow('disk full')
    expect(target.fetch).toHaveBeenLastCalledWith('/workspace-files/delete/uploads/x-agent/id', { method: 'DELETE' })
  })
})
