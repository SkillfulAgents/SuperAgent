import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remoteClientContract } from './testing/remote-client-contract'
const { lookup, forward, audit, owner } = vi.hoisted(() => ({ lookup: vi.fn(), forward: vi.fn(), audit: vi.fn(), owner: vi.fn() }))
vi.mock('@shared/lib/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: lookup }) }) }) } }))
vi.mock('@shared/lib/account-providers/provider-factory', () => ({ getAccountProviderByName: () => ({ makeApiCall: forward }) }))
vi.mock('@shared/lib/platform-attribution', () => ({ attribution: { fromResourceCreator: owner }, runWithAttribution: (_owner: unknown, run: () => unknown) => run() }))
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: audit }))
import { githubBlob, githubBranches, githubFolder, githubHead, githubRepo, githubRepos, githubRequest, githubTree, requireGithubAccount } from './github-client'
import { GithubMountableVolume, prepareGithubVolume } from './github-mountable-volume'
import { withRemoteAccount } from './remote-account'
import { githubVolumeConfigSchema } from './github-schema'

remoteClientContract({
  toolkit: 'github', lookup, forward, audit, owner,
  read: (id = 'account') => githubRequest(id, 'repositories/123'),
  operation: run => withRemoteAccount('account', 'github', run),
})

const sha = 'a'.repeat(40)
const childSha = 'b'.repeat(40)
const config = githubVolumeConfigSchema.parse({ accountId: 'github-account', repoId: 123, owner: 'team', repo: 'project', branch: 'release/docs', path: '' })
const repo = { id: 123, name: 'project', owner: { login: 'team' } }
const account = { id: config.accountId, toolkitSlug: 'github', status: 'active', userId: 'alice', providerName: 'composio', providerConnectionId: 'connection' }
let test = 0

describe('GitHub responses', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers({ now: new Date('2036-01-01').getTime() + ++test * 100_000 })
    lookup.mockResolvedValue(account)
    owner.mockResolvedValue(null)
  })
  afterEach(() => { vi.useRealTimers() })

  it.each(['reset', 'retry-after'])('retries a rate-limited 403 with %s but refuses an ordinary 403', async header => {
    const headers = new Headers(header === 'retry-after' ? { 'retry-after': '2' }
      : { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.now() / 1000 + 2) })
    forward.mockResolvedValueOnce(Response.json({ message: 'Rate limit exceeded' }, { status: 403, headers }))
      .mockResolvedValueOnce(Response.json(repo))
    const pending = githubRepo(config)
    await vi.advanceTimersByTimeAsync(1999)
    expect(forward).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual(repo)
    forward.mockResolvedValueOnce(Response.json({ message: 'Forbidden' }, { status: 403 }))
    await expect(githubRepo(config)).rejects.toMatchObject({ code: 'not-accessible' })
    expect(forward).toHaveBeenCalledTimes(3)
  })

  it.each(['{', '{}'])('maps malformed provider JSON %s to availability, not configuration failure', async body => {
    forward.mockResolvedValueOnce(new Response(body))
    await expect(githubRepo(config)).rejects.toMatchObject({ status: 503, message: 'GitHub is temporarily unavailable. Please try again.' })
  })

  it('maps a 404 to not-found without retrying', async () => {
    forward.mockResolvedValueOnce(Response.json({ message: 'Not Found' }, { status: 404 }))
    await expect(githubRepo(config)).rejects.toMatchObject({ code: 'not-found' })
    expect(forward).toHaveBeenCalledOnce()
  })

  it.each([409, 422, 451])('preserves the message for %i without retrying', async status => {
    forward.mockResolvedValueOnce(Response.json({ message: 'Repository unavailable for this request' }, { status }))
    await expect(githubRepo(config)).rejects.toMatchObject({ code: 'not-accessible', message: 'Repository unavailable for this request' })
    expect(forward).toHaveBeenCalledOnce()
  })

  it('rejects a revoked or foreign account before any network call', async () => {
    lookup.mockResolvedValueOnce({ ...account, status: 'expired' })
    await expect(githubHead(config)).rejects.toMatchObject({ code: 'not-accessible' })
    await expect(requireGithubAccount(config.accountId, { userId: 'bob' })).rejects.toMatchObject({ code: 'not-found' })
    expect(forward).not.toHaveBeenCalled()
    forward.mockResolvedValueOnce(Response.json({ object: { sha } }))
    expect(await githubHead(config)).toBe(sha)
    expect(forward).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ targetUrl: 'https://api.github.com/repositories/123/git/ref/heads/release%2Fdocs' }))
  })

  it('requests the next page when repos and branches contain exactly 100 entries', async () => {
    forward.mockResolvedValueOnce(Response.json(Array.from({ length: 100 }, (_, index) => ({ ...repo, id: index + 1 }))))
      .mockResolvedValueOnce(Response.json([]))
    expect(await githubRepos(config.accountId)).toHaveLength(100)
    expect(forward).toHaveBeenLastCalledWith(expect.objectContaining({ targetUrl: 'https://api.github.com/user/repos?per_page=100&sort=full_name&page=2' }))
    forward.mockResolvedValueOnce(Response.json(Array.from({ length: 100 }, (_, index) => ({ name: `branch-${index}` }))))
      .mockResolvedValueOnce(Response.json([]))
    expect(await githubBranches(config)).toHaveLength(100)
    expect(forward).toHaveBeenLastCalledWith(expect.objectContaining({ targetUrl: 'https://api.github.com/repositories/123/branches?per_page=100&page=2' }))
    expect(forward).toHaveBeenCalledTimes(4)
  })

  it('walks a truncated tree and filters unsupported names before validating copy paths', async () => {
    const folder = { path: 'docs', sha: childSha, mode: '040000', type: 'tree' }
    const file = { path: 'readme.md', sha, mode: '100644', type: 'blob', size: 0 }
    forward.mockResolvedValueOnce(Response.json({ tree: [], truncated: true }))
      .mockResolvedValueOnce(Response.json({ tree: [folder, { ...file, path: 'bad\\name' }, { ...file, path: 'bad\0name' }], truncated: false }))
      .mockResolvedValueOnce(Response.json({ tree: [file], truncated: false }))
    expect(await githubTree({ ...config, path: 'docs' }, sha)).toEqual([{ ...file, path: 'docs/readme.md' }])
    expect(forward.mock.calls.map(([call]) => call.targetUrl)).toEqual([
      `https://api.github.com/repositories/123/git/trees/${sha}?recursive=1`,
      `https://api.github.com/repositories/123/git/trees/${sha}`,
      `https://api.github.com/repositories/123/git/trees/${childSha}`,
    ])
  })

  it('lists every folder of a truncated tree when listings finish out of order', async () => {
    const [a, b] = ['c', 'd'].map(c => c.repeat(40))
    let releaseA!: () => void
    const heldA = new Promise<void>(resolve => { releaseA = resolve })
    forward.mockImplementation(async ({ targetUrl }: { targetUrl: string }) => {
      if (targetUrl.endsWith('?recursive=1')) return Response.json({ tree: [], truncated: true })
      if (targetUrl.endsWith(`/git/trees/${sha}`)) return Response.json({ tree: [{ path: 'a', sha: a, mode: '040000', type: 'tree' }, { path: 'b', sha: b, mode: '040000', type: 'tree' }], truncated: false })
      if (targetUrl.endsWith(`/git/trees/${a}`)) { await heldA; return Response.json({ tree: [{ path: 'one', sha, mode: '100644', type: 'blob' }], truncated: false }) }
      return Response.json({ tree: [{ path: 'two', sha, mode: '100644', type: 'blob' }], truncated: false })
    })
    const walk = githubTree(config, sha)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    releaseA()
    expect((await walk).map(entry => entry.path).sort()).toEqual(['a', 'a/one', 'b', 'b/two'])
  })

  it('stops listing folders of a truncated tree once one listing fails', async () => {
    const folders = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}`, sha: String(i).repeat(40), mode: '040000', type: 'tree' }))
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    forward.mockImplementation(async ({ targetUrl }: { targetUrl: string }) => {
      if (targetUrl.endsWith('?recursive=1')) return Response.json({ tree: [], truncated: true })
      if (targetUrl.endsWith(`/git/trees/${sha}`)) return Response.json({ tree: folders, truncated: false })
      if (targetUrl.endsWith(`/git/trees/${folders[0].sha}`)) return Response.json({ message: 'Not Found' }, { status: 404 })
      await held
      return Response.json({ tree: [{ path: 'deeper', sha: childSha, mode: '040000', type: 'tree' }], truncated: false })
    })
    await expect(githubTree(config, sha)).rejects.toMatchObject({ code: 'not-found' })
    release()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(forward.mock.calls.filter(([call]) => call.targetUrl.endsWith(`/git/trees/${childSha}`))).toEqual([])
    expect(forward).toHaveBeenCalledTimes(10)
  })

  it('filters out-of-root entries in a complete recursive listing', async () => {
    const file = { path: 'docs/inside', sha, mode: '100644', type: 'blob' }
    forward.mockResolvedValueOnce(Response.json({ tree: [file, { ...file, path: 'docs-other/outside' }, { ...file, path: 'outside' }], truncated: false }))
    expect(await githubTree({ ...config, path: 'docs' }, sha)).toEqual([file])
    expect(forward).toHaveBeenCalledOnce()
  })

  it('decodes binary blobs from the proxy JSON response without changing bytes', async () => {
    const bytes = Buffer.from([0, 255, 128, 10, 13])
    forward.mockResolvedValueOnce(Response.json({ encoding: 'base64', content: bytes.toString('base64') + '\n', sha }))
    expect(await githubBlob(config, sha)).toEqual(bytes)
    expect(forward).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ targetUrl: `https://api.github.com/repositories/123/git/blobs/${sha}` }))
  })

  it('refuses a truncated single-level listing instead of copying an incomplete tree', async () => {
    forward.mockResolvedValueOnce(Response.json({ tree: [], truncated: true }))
      .mockResolvedValueOnce(Response.json({ tree: [], truncated: true }))
    await expect(githubTree(config, sha)).rejects.toMatchObject({ status: 503, message: 'GitHub returned an incomplete folder listing.' })
    expect(forward).toHaveBeenCalledTimes(2)
  })

  it('refuses a selected folder that is a file', async () => {
    forward.mockResolvedValueOnce(Response.json({ tree: [{ path: 'docs', sha, mode: '100644', type: 'blob' }], truncated: false }))
    await expect(githubFolder({ ...config, path: 'docs' }, sha)).rejects.toMatchObject({ code: 'not-a-directory' })
    expect(forward).toHaveBeenCalledOnce()
  })

  it('browses and validates only the selected folder levels', async () => {
    forward.mockImplementation(async ({ targetUrl }: { targetUrl: string }) => {
      if (targetUrl.endsWith('/git/ref/heads/release%2Fdocs')) return Response.json({ object: { sha } })
      if (targetUrl.endsWith(`/git/trees/${sha}`)) return Response.json({ tree: [{ path: 'docs', sha: childSha, mode: '040000', type: 'tree' }], truncated: false })
      if (targetUrl.endsWith(`/git/trees/${childSha}`)) return Response.json({ tree: [{ path: 'nested', sha, mode: '040000', type: 'tree' }], truncated: false })
      if (targetUrl.endsWith('/repositories/123')) return Response.json(repo)
      throw new Error(`Unexpected URL: ${targetUrl}`)
    })
    const selected = { ...config, path: 'docs' }
    expect(await GithubMountableVolume.browseFolders({ accountId: config.accountId, repoId: config.repoId, branch: config.branch, path: 'docs' }, { userId: 'alice' }))
      .toEqual({ folders: [{ id: 'docs/nested', name: 'nested' }] })
    expect(forward).toHaveBeenCalledTimes(3)
    expect(await prepareGithubVolume(selected, { userId: 'alice' })).toEqual({ name: 'docs', config: selected })
    expect(forward).toHaveBeenCalledTimes(7)
    expect(forward.mock.calls.every(([call]) => !call.targetUrl.includes('recursive'))).toBe(true)
  })
})
