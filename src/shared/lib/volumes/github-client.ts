import { z } from 'zod'
import pLimit from 'p-limit'
import { getAccountProviderByName } from '@shared/lib/account-providers/provider-factory'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import {
  githubBlobSchema, githubBranchesSchema, githubErrorSchema, githubHeadSchema, githubOidSchema, githubPathSchema, githubRepoSchema, githubReposSchema, githubTreeSchema,
  type GithubTreeEntry, type GithubVolumeConfig,
} from './github-schema'
import { requireAccount, withRemoteAttribution } from './remote-account'
import { RemoteRequestPacer, retryAfterSeconds } from './remote-request-pacer'
import { VolumeError } from './volume-error'

const HOST = 'api.github.com'
const unavailable = (status: 429 | 503, delay?: number) => new VolumeError(status === 429
  ? 'GitHub is busy. Please try again shortly.' : 'GitHub is temporarily unavailable. Please try again.', status, delay)
const pacer = new RemoteRequestPacer(unavailable)

export function requireGithubAccount(accountId: string, creator?: { userId: string | null }) {
  return requireAccount(accountId, 'github', creator)
}

async function responseError(response: Response): Promise<Error> {
  if (response.status === 429 ||
    (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    return unavailable(429, retryAfterSeconds(response, reset > 0 ? Math.max(0, reset - Date.now() / 1000) : undefined))
  }
  if (response.status === 404) return new WorkspaceFileError('not-found', 'The GitHub repository or branch is unavailable.')
  if (response.status === 401 || response.status === 403) {
    return new WorkspaceFileError('not-accessible', 'GitHub refused access. Check the account connection and branch permissions.')
  }
  if (response.status >= 500) return unavailable(503)
  const error = githubErrorSchema.safeParse(await response.json().catch(() => null))
  return new WorkspaceFileError('not-accessible', error.success ? error.data.message : response.statusText)
}

export async function githubRequest(accountId: string, path: string): Promise<Response> {
  const headers = new Headers({ Accept: 'application/vnd.github+json' })
  return withRemoteAttribution(accountId, 'github', account => pacer.run(accountId, true, async () => {
    let response: Response
    try {
      response = await getAccountProviderByName(account.providerName).makeApiCall({
        providerConnectionId: account.providerConnectionId, toolkitSlug: 'github',
        targetUrl: `https://${HOST}/${path}`, method: 'GET', headers, body: null,
      })
    } catch { throw unavailable(503) }
    if (!response.ok) throw await responseError(response)
    return response
  }))
}

async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  try { return schema.parse(await response.json()) } catch { throw unavailable(503) }
}

export async function githubRepo(config: Pick<GithubVolumeConfig, 'accountId' | 'repoId'>) {
  return json(await githubRequest(config.accountId, `repositories/${config.repoId}`), githubRepoSchema)
}

export async function githubHead(config: Pick<GithubVolumeConfig, 'accountId' | 'repoId' | 'branch'>) {
  const response = await githubRequest(config.accountId, `repositories/${config.repoId}/git/ref/heads/${encodeURIComponent(config.branch)}`)
  return (await json(response, githubHeadSchema)).object.sha
}

async function tree(config: Pick<GithubVolumeConfig, 'accountId' | 'repoId'>, oid: string, recursive = false) {
  const listing = await json(await githubRequest(config.accountId,
    `repositories/${config.repoId}/git/trees/${githubOidSchema.parse(oid)}${recursive ? '?recursive=1' : ''}`), githubTreeSchema)
  if (!recursive && listing.truncated) throw new VolumeError('GitHub returned an incomplete folder listing.', 503)
  return listing
}

export async function githubFolder(config: Pick<GithubVolumeConfig, 'accountId' | 'repoId' | 'path'>, sha: string): Promise<GithubTreeEntry[]> {
  const root = githubPathSchema.parse(config.path)
  const parts = root ? root.split('/') : []
  for (let level = 0; ; level++) {
    const listing = await tree(config, sha)
    if (level === parts.length) return listing.tree.map(entry => ({ ...entry, path: root ? `${root}/${entry.path}` : entry.path }))
    const folder = listing.tree.find(entry => entry.type === 'tree' && entry.path === parts[level])
    if (!folder) throw new WorkspaceFileError('not-a-directory', 'Select a GitHub folder')
    sha = folder.sha
  }
}

export async function githubTree(config: Pick<GithubVolumeConfig, 'accountId' | 'repoId' | 'path'>, sha: string): Promise<GithubTreeEntry[]> {
  const recursive = await tree(config, sha, true)
  let entries = recursive.tree
  if (recursive.truncated) {
    entries = []
    const limit = pLimit(8)
    let failed = false
    // A repo over GitHub's one-listing limit is listed folder by folder, 8 at a time.
    const walk = async (folderSha: string, prefix: string): Promise<void> => {
      if (failed) return
      const listing = await limit(() => failed ? null : tree(config, folderSha).catch(error => { failed = true; throw error }))
      if (!listing) return
      await Promise.all(listing.tree.map(entry => {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path
        entries.push({ ...entry, path })
        return entry.type === 'tree' ? walk(entry.sha, path) : undefined
      }))
    }
    await walk(sha, '').finally(() => limit.clearQueue())
  }
  const root = githubPathSchema.parse(config.path)
  return entries.filter(entry => !root || entry.path.startsWith(`${root}/`))
}

export async function githubTarball(config: Pick<GithubVolumeConfig, 'accountId' | 'repoId'>, sha: string): Promise<Response> {
  return githubRequest(config.accountId, `repositories/${config.repoId}/tarball/${githubOidSchema.parse(sha)}`)
}

export async function githubBlob(config: Pick<GithubVolumeConfig, 'accountId' | 'repoId'>, sha: string): Promise<Buffer> {
  const response = await githubRequest(config.accountId, `repositories/${config.repoId}/git/blobs/${githubOidSchema.parse(sha)}`)
  const blob = await json(response, githubBlobSchema)
  return Buffer.from(blob.content, 'base64')
}

async function pages<T>(accountId: string, endpoint: string, schema: z.ZodType<T[]>): Promise<T[]> {
  const entries: T[] = []
  for (let page = 1; ; page++) {
    const batch = await json(await githubRequest(accountId, `${endpoint}&page=${page}`), schema)
    entries.push(...batch)
    if (batch.length < 100) return entries
  }
}

export async function githubRepos(accountId: string) {
  return pages(accountId, 'user/repos?per_page=100&sort=full_name', githubReposSchema)
}

export async function githubBranches(config: Pick<GithubVolumeConfig, 'accountId' | 'repoId'>) {
  return pages(config.accountId, `repositories/${config.repoId}/branches?per_page=100`, githubBranchesSchema)
}
