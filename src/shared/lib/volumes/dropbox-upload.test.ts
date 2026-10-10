import { beforeEach, describe, expect, it, vi } from 'vitest'
const { proxy, token } = vi.hoisted(() => ({ proxy: vi.fn(), token: vi.fn() }))
vi.mock('@shared/lib/composio/client', () => ({
  getConnectionToken: token, proxyExecute: proxy,
  ComposioRedactedTokenError: class extends Error {},
}))
vi.mock('@shared/lib/db', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ get: async () => ({
    id: 'account', toolkitSlug: 'dropbox', status: 'active', userId: null,
    providerName: 'composio', providerConnectionId: 'connection',
  }) }) }) }),
} }))
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { fromResourceCreator: async () => null },
  runWithAttribution: (_owner: unknown, run: () => unknown) => run(),
}))
vi.mock('@shared/lib/account-providers/provider-factory', () => ({ getAccountProviderByName: () => provider }))
import { ComposioRedactedTokenError, type ProxyExecuteParams } from '@shared/lib/composio/client'
import { ComposioAccountProvider } from '@shared/lib/account-providers/composio-account-provider'
import { DropboxMountableVolume, DROPBOX_UPLOAD_CHUNK_BYTES } from './dropbox-mountable-volume'

let provider: ComposioAccountProvider
beforeEach(() => {
  vi.resetAllMocks()
  provider = new ComposioAccountProvider()
  token.mockRejectedValue(new ComposioRedactedTokenError('Managed account'))
})

/** Exercise the real adapter, Dropbox client, header encoding and Composio
 * provider together. Simulate the platform wire limit, not just Dropbox's API. */
describe('Dropbox uploads through the managed Composio transport', () => {
  it.each([0, 21, DROPBOX_UPLOAD_CHUNK_BYTES, DROPBOX_UPLOAD_CHUNK_BYTES + 1, 5 * 1024 * 1024])(
    'commits all %i bytes within the encoded request cap', async size => {
      let committed: Buffer | undefined
      const staged: Buffer[] = []
      const requestSizes: number[] = []
      proxy.mockImplementation(async (p: ProxyExecuteParams) => {
        const wire = JSON.stringify({
          endpoint: p.endpoint, method: p.method, connected_account_id: p.connectedAccountId,
          parameters: p.parameters, body: p.body, binary_body: p.binaryBody,
        })
        requestSizes.push(Buffer.byteLength(wire))
        if (Buffer.byteLength(wire) > 1_000_000) throw new Error('Platform: Payload too large')
        const argsHeader = p.parameters?.find(header => header.name.toLowerCase() === 'dropbox-api-arg')?.value
        const args = argsHeader ? JSON.parse(argsHeader) : p.body
        const bytes = p.binaryBody && 'base64' in p.binaryBody ? Buffer.from(p.binaryBody.base64, 'base64') : Buffer.alloc(0)
        if (p.binaryBody && p.parameters?.some(header => header.name.toLowerCase() === 'content-type')) {
          return { status: 400, data: 'Dropbox: found multiple Content-Type headers', headers: {} }
        }
        const result = (data: unknown, status = 200) => ({ status, data, headers: {} })
        if (p.endpoint.endsWith('/get_metadata')) {
          if (args.path === '/Team') return result({ '.tag': 'folder', name: 'Team', id: 'id:team' })
          return result({ error_summary: 'path/not_found/' }, 409)
        }
        if (p.endpoint.endsWith('/upload')) { committed = bytes; return result(null) }
        if (p.endpoint.endsWith('/upload_session/start')) {
          staged.push(bytes)
          return result({ session_id: 'session' })
        }
        expect(args.cursor).toEqual({ session_id: 'session', offset: staged.reduce((total, chunk) => total + chunk.length, 0) })
        if (p.endpoint.endsWith('/upload_session/append_v2')) staged.push(bytes)
        else if (p.endpoint.endsWith('/upload_session/finish')) committed = Buffer.concat([...staged, bytes])
        else throw new Error('Unexpected upload endpoint')
        return result(null)
      })
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256)
      const volume = new DropboxMountableVolume('volume', 'Team', { accountId: 'account', path: '/Team' })
      await volume.write('test.bin', new Blob([bytes]).stream())
      expect(committed?.length).toBe(size)
      expect(committed?.equals(Buffer.from(bytes))).toBe(true)
      expect(Math.max(...requestSizes)).toBeLessThanOrEqual(1_000_000)
      const endpoints = proxy.mock.calls.map(([p]) => p.endpoint as string)
      expect(endpoints.filter(endpoint => endpoint.endsWith('/upload_session/finish'))).toHaveLength(size > DROPBOX_UPLOAD_CHUNK_BYTES ? 1 : 0)
      expect(endpoints.filter(endpoint => endpoint.endsWith('/upload'))).toHaveLength(size <= DROPBOX_UPLOAD_CHUNK_BYTES ? 1 : 0)
    },
  )
})
