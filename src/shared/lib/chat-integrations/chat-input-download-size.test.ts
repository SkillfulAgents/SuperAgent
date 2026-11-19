import { describe, it, expect, afterEach, vi } from 'vitest'
import { ChatInputBuilder } from './chat-input'

const chatInput = new ChatInputBuilder(async () => undefined)
const DOWNLOAD_URL = 'https://files.slack.com/files-pri/T123-F456/report.pdf'
const LIMIT = 50 * 1024 * 1024

function download(): Promise<Buffer | null> {
  return (chatInput as any).downloadWithAuth(DOWNLOAD_URL, 'xoxb-token')
}

describe('chat attachment download size limit', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses a download whose Content-Length is over the limit without reading the body', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024))
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-length': String(LIMIT + 1) },
    })))

    expect(await download()).toBeNull()
    // Only what the stream pre-fills before anyone reads; never the whole file.
    expect(pulled).toBeLessThanOrEqual(1)
  })

  it('stops reading once a download with no Content-Length passes the limit', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    expect(await download()).toBeNull()
    expect(sent).toBeLessThanOrEqual(LIMIT + 2 * chunk.byteLength)
  })

  it('returns a download under the limit whole', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-1.7 report bytes', { status: 200 })))

    expect((await download())?.toString()).toBe('%PDF-1.7 report bytes')
  })
})
