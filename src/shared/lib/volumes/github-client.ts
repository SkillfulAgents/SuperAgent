import { z } from 'zod'
import pLimit from 'p-limit'
import { getAccountProviderByName } from '@shared/lib/account-providers/provider-factory'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import {
  githubBlobSchema, githubBranchesSchema, githubCommitReplySchema, githubErrorSchema, githubHeadSchema, githubOidSchema, githubPathSchema, githubRepoSchema, githubReposSchema, githubTreeSchema,
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

/** A request with a body is a mutation, so the pacer never replays it. */
export async function githubRequest(accountId: string, path: string, body?: unknown): Promise<Response> {
  const headers = new Headers({ Accept: 'application/vnd.github+json' })
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  const bytes = body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)).buffer
  return withRemoteAttribution(accountId, 'github', account => pacer.run(accountId, body === undefined, async () => {
    let response: Response
    try {
      response = await getAccountProviderByName(account.providerName).makeApiCall({
        providerConnectionId: account.providerConnectionId, toolkitSlug: 'github',
        targetUrl: `https://${HOST}/${path}`, method: bytes ? 'POST' : 'GET', headers,
        body: bytes,
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

/** Folder listings by tree SHA. A SHA names one listing, so a folder whose SHA is known needs no request. */
export type GithubTrees = Map<string, GithubTreeEntry[]>

const under = (prefix: string, entry: GithubTreeEntry) => ({ ...entry, path: prefix ? `${prefix}/${entry.path}` : entry.path })

/**
 * Every entry under the drive's folder, and the entries beside each folder above it. A folder that fits one
 * recursive listing costs one request. A larger one is listed folder by folder, 8 at a time, skipping folders
 * whose listing `known` holds. On return `known` holds this walk's folders, or nothing when one listing sufficed.
 */
export async function githubTree(config: Pick<GithubVolumeConfig, 'accountId' | 'repoId' | 'path'>, sha: string, known: GithubTrees = new Map()): Promise<GithubTreeEntry[]> {
  const seen: GithubTrees = new Map()
  const list = async (folderSha: string) => {
    let children = known.get(folderSha)
    if (!children) {
      const listing = await tree(config, folderSha)
      children = listing.tree
      folderSha = listing.sha ?? folderSha
    }
    seen.set(folderSha, children)
    return children
  }
  const root = githubPathSchema.parse(config.path)
  const entries: GithubTreeEntry[] = []
  // Each folder above the drive is listed alone: a subfolder drive needs only the files beside its path.
  let prefix = ''
  for (const part of root ? root.split('/') : []) {
    const children = await list(sha)
    entries.push(...children.map(entry => under(prefix, entry)))
    const folder = children.find(entry => entry.type === 'tree' && entry.path === part)
    if (!folder) return entries
    sha = folder.sha
    prefix = prefix ? `${prefix}/${part}` : part
  }
  // A folder walked before is walked again, without first asking for the listing GitHub truncated last time.
  if (!known.size) {
    const recursive = await tree(config, sha, true)
    if (!recursive.truncated) return entries.concat(recursive.tree.map(entry => under(prefix, entry)))
  }
  const limit = pLimit(8)
  let failed = false
  const walk = async (folderSha: string, path: string): Promise<void> => {
    if (failed) return
    const children = await limit(() => failed ? null : list(folderSha).catch(error => { failed = true; throw error }))
    if (!children) return
    await Promise.all(children.map(entry => {
      const child = under(path, entry)
      entries.push(child)
      return entry.type === 'tree' ? walk(entry.sha, child.path) : undefined
    }))
  }
  await walk(sha, prefix).finally(() => limit.clearQueue())
  known.clear()
  for (const [folderSha, children] of seen) known.set(folderSha, children)
  return entries
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

/** Lands one commit on the branch only if its head is still `expectedHeadOid`. A refusal throws a
 * WorkspaceFileError, and a lost or failed reply throws a VolumeError: the caller re-reads the head
 * to tell a moved branch from a real refusal. */
export async function githubCommit(config: GithubVolumeConfig, expectedHeadOid: string,
  changes: { path: string; contents: Buffer | null }[], headline: string): Promise<string> {
  const response = await githubRequest(config.accountId, 'graphql', {
    query: 'mutation($i:CreateCommitOnBranchInput!){createCommitOnBranch(input:$i){commit{oid}}}',
    variables: { i: {
      branch: { repositoryNameWithOwner: `${config.owner}/${config.repo}`, branchName: config.branch },
      message: { headline }, expectedHeadOid,
      fileChanges: {
        additions: changes.flatMap(change => change.contents ? [{ path: change.path, contents: change.contents.toString('base64') }] : []),
        deletions: changes.flatMap(change => change.contents ? [] : [{ path: change.path }]),
      },
    } },
  })
  const reply = await json(response, githubCommitReplySchema)
  const oid = reply.data?.createCommitOnBranch?.commit?.oid
  if (oid) return oid
  throw new WorkspaceFileError('not-accessible', `GitHub refused the push: ${reply.errors?.[0]?.message ?? 'no commit returned'}`)
}
