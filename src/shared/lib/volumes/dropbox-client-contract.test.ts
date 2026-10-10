import { vi } from 'vitest'
import { remoteClientContract } from './testing/remote-client-contract'
const { lookup, forward, audit, owner } = vi.hoisted(() => ({ lookup: vi.fn(), forward: vi.fn(), audit: vi.fn(), owner: vi.fn() }))
vi.mock('@shared/lib/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: lookup }) }) }) } }))
vi.mock('@shared/lib/account-providers/provider-factory', () => ({ getAccountProviderByName: () => ({ makeApiCall: forward }) }))
vi.mock('@shared/lib/platform-attribution', () => ({ attribution: { fromResourceCreator: owner }, runWithAttribution: (_owner: unknown, run: () => unknown) => run() }))
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: audit }))
import { dropboxRequest, withDropboxAccount } from './dropbox-client'
remoteClientContract({
  toolkit: 'dropbox', lookup, forward, audit, owner,
  read: (id = 'account') => dropboxRequest(id, 'list_folder', {}, { agentSlug: 'agent' }),
  write: signal => dropboxRequest('account', 'upload', {}, { agentSlug: 'agent', signal }),
  operation: run => withDropboxAccount('account', run),
})
