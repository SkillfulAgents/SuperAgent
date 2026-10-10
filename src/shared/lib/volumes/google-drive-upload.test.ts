import { beforeEach, describe, expect, it, vi } from 'vitest'
const { proxy, token } = vi.hoisted(() => ({ proxy: vi.fn(), token: vi.fn() }))
vi.mock('@shared/lib/composio/client', () => ({
  getConnectionToken: token, proxyExecute: proxy, ComposioRedactedTokenError: class extends Error {},
}))
vi.mock('@shared/lib/db', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ get: async () => ({
    id: 'account', toolkitSlug: 'googledrive', status: 'active', userId: null,
    providerName: 'composio', providerConnectionId: 'connection',
  }) }) }) }),
} }))
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { fromResourceCreator: async () => null }, runWithAttribution: (_owner: unknown, run: () => unknown) => run(),
}))
vi.mock('@shared/lib/account-providers/provider-factory', () => ({ getAccountProviderByName: () => provider }))
import { ComposioRedactedTokenError, type ProxyExecuteParams } from '@shared/lib/composio/client'
import { ComposioAccountProvider } from '@shared/lib/account-providers/composio-account-provider'
import { driveUpload, UPLOAD_CHUNK_BYTES } from './google-drive-client'

let provider: ComposioAccountProvider
beforeEach(() => {
  vi.resetAllMocks()
  provider = new ComposioAccountProvider()
  token.mockRejectedValue(new ComposioRedactedTokenError('Managed account'))
})

describe('Google Drive uploads through the managed Composio transport', () => {
  it.each([0, 21, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES + 1, 5 * 1024 * 1024])('commits all %i bytes within the encoded request cap', async size => {
    let committed: Buffer | undefined
    const staged: Buffer[] = []
    let multipart = 0
    proxy.mockImplementation(async (p: ProxyExecuteParams) => {
      const wire = JSON.stringify({ endpoint: p.endpoint, method: p.method, connected_account_id: p.connectedAccountId, parameters: p.parameters, body: p.body, binary_body: p.binaryBody })
      expect(Buffer.byteLength(wire)).toBeLessThan(1_000_000)
      const url = new URL(p.endpoint)
      const bytes = p.binaryBody && 'base64' in p.binaryBody ? Buffer.from(p.binaryBody.base64, 'base64') : Buffer.alloc(0)
      if (p.binaryBody) expect(p.parameters?.some(header => header.name.toLowerCase() === 'content-type')).toBeFalsy()
      const stored = () => ({ status: 200, data: { id: 'file', name: 'café.bin', mimeType: 'application/octet-stream', size: String(size), modifiedTime: '2026-10-07T12:00:00Z' }, headers: {} })
      if (url.searchParams.get('uploadType') === 'multipart') {
        multipart++
        const contentType = p.binaryBody && 'content_type' in p.binaryBody ? p.binaryBody.content_type ?? '' : ''
        expect(contentType).toMatch(/^multipart\/related; boundary=/)
        const boundary = contentType.split('boundary=')[1]
        const metaStart = bytes.indexOf('\r\n\r\n') + 4
        const metaEnd = bytes.indexOf(`\r\n--${boundary}`, metaStart)
        expect(JSON.parse(bytes.subarray(metaStart, metaEnd).toString())).toEqual({ name: 'café.bin', parents: ['team'] })
        const contentStart = bytes.indexOf('\r\n\r\n', metaEnd) + 4
        committed = bytes.subarray(contentStart, bytes.lastIndexOf(`\r\n--${boundary}--`))
        return stored()
      }
      if (url.searchParams.get('uploadType') === 'resumable') return { status: 200, data: null, headers: { Location: 'https://www.googleapis.com/upload/session' } }
      const range = p.parameters?.find(header => header.name.toLowerCase() === 'content-range')?.value
      staged.push(bytes)
      if (range?.endsWith('/*')) return { status: 308, data: null, headers: {} }
      committed = Buffer.concat(staged)
      return stored()
    })
    const content = Uint8Array.from({ length: size }, (_, i) => i % 256)
    await driveUpload('account', { method: 'POST', path: 'upload/drive/v3/files', json: { name: 'café.bin', parents: ['team'] } }, new Blob([content]).stream())
    expect(committed?.equals(Buffer.from(content))).toBe(true)
    expect(multipart).toBe(size <= UPLOAD_CHUNK_BYTES ? 1 : 0)
    if (size <= UPLOAD_CHUNK_BYTES) expect(proxy).toHaveBeenCalledOnce()
  })

  it('updates a Google Doc in one request with the import MIME type in the media part', async () => {
    proxy.mockImplementation(async (p: ProxyExecuteParams) => {
      expect(p.method).toBe('PATCH')
      expect(p.endpoint).toContain('/upload/drive/v3/files/doc?')
      expect(p.binaryBody && 'base64' in p.binaryBody && Buffer.from(p.binaryBody.base64, 'base64').toString()).toContain('Content-Type: text/markdown\r\n\r\n# Updated')
      return { status: 200, data: { id: 'doc', name: 'Plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-07T12:00:00Z' }, headers: {} }
    })
    await driveUpload('account', { method: 'PATCH', path: 'upload/drive/v3/files/doc', json: {}, contentType: 'text/markdown' }, new Blob(['# Updated']).stream())
    expect(proxy).toHaveBeenCalledOnce()
  })
})
