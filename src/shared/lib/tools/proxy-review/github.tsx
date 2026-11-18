import type { ReactNode } from 'react'
import { formatFileSize } from '@shared/lib/utils/format-file-size'
import { TitleCode, type CustomPreview } from './custom-previews'

// A path with direction controls could display as another file name, so it keeps today's card.
const REPO = '^(?![^]*[\u202a-\u202e\u2066-\u2069])repos/([^/]+)/([^/]+)'
const CONTENTS_PATH = new RegExp(`${REPO}/contents/(.+?)/?$`)
const BLOB_PATH = new RegExp(`${REPO}/git/blobs$`)
const TREE_PATH = new RegExp(`${REPO}/git/trees$`)

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Characters that reorder how text displays, so a card could show something other than what GitHub stores. */
const DIRECTION_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/

/** The request body as an object. Undefined when the card's copy is cut short, is not an object, or holds text that could display as something else. */
function bodyOf(requestBody: string): Record<string, unknown> | undefined {
  let json: unknown
  try {
    json = JSON.parse(requestBody)
  } catch {
    return undefined
  }
  // Checked after parsing: a body the card did not re-serialize still carries \u escapes.
  return isRecord(json) && !DIRECTION_CONTROLS.test(JSON.stringify(json)) ? json : undefined
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

const personOf = (value: unknown) => {
  if (!isRecord(value)) return undefined
  const email = text(value.email)
  const date = text(value.date)
  return [text(value.name), email && `<${email}>`, date && `on ${date}`].filter(Boolean).join(' ') || undefined
}

/** The card's copy of a long body ends with an ellipsis at the cut, past which the content cannot be read. */
const isCut = (requestBody: string) => requestBody.endsWith('…')

/** File content GitHub will store. Text is absent when the content is binary. */
export interface GitHubBlob {
  text?: string
  lines: number
  bytes: number
}

function blobOf(content: unknown, encoding: unknown): GitHubBlob | undefined {
  if (typeof content !== 'string') return undefined
  let bytes: Uint8Array
  if (encoding === 'utf-8') {
    bytes = new TextEncoder().encode(content)
  } else if (encoding === 'base64') {
    try {
      bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), (char) => char.charCodeAt(0))
    } catch {
      return undefined
    }
  } else {
    return undefined
  }
  let decoded: string | undefined
  try {
    decoded = bytes.includes(0) ? undefined : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    decoded = undefined
  }
  if (decoded !== undefined && DIRECTION_CONTROLS.test(decoded)) return undefined
  return { text: decoded, lines: decoded === undefined || decoded === '' ? 0 : decoded.replace(/\n$/, '').split('\n').length, bytes: bytes.length }
}

/** A new blob. The encoding defaults to text. */
export function readGitHubBlob(requestBody: string): GitHubBlob | undefined {
  const body = bodyOf(requestBody)
  return body && blobOf(body.content, body.encoding ?? 'utf-8')
}

/** A file created or updated in one commit. GitHub takes its content as base64 only. */
export interface GitHubFileCommit {
  message: string
  /** Absent when the commit goes to the default branch. */
  branch?: string
  /** The file exists and this replaces it. */
  update: boolean
  /** Absent when the commit is attributed to the connected account. */
  author?: string
  committer?: string
  file: GitHubBlob
}

export function readGitHubFileCommit(requestBody: string): GitHubFileCommit | undefined {
  const body = bodyOf(requestBody)
  const message = text(body?.message)
  const file = body && blobOf(body.content, 'base64')
  if (!body || message === undefined || !file) return undefined
  return { message, branch: text(body.branch), update: typeof body.sha === 'string', author: personOf(body.author), committer: personOf(body.committer), file }
}

/** One file path in a new tree, and where its content comes from. */
export interface GitHubTreeEntry {
  path: string
  change: 'new content' | 'stored content' | 'deleted'
  executable: boolean
}

export interface GitHubTree {
  entries: GitHubTreeEntry[]
  /** No base tree: the commit keeps only these paths. */
  replacesAll: boolean
}

export function readGitHubTree(requestBody: string): GitHubTree | undefined {
  const body = bodyOf(requestBody)
  if (!body || !Array.isArray(body.tree)) return undefined
  const entries: GitHubTreeEntry[] = []
  for (const entry of body.tree) {
    // A folder, submodule, or symlink would show as an ordinary file, so the card leaves those to the raw request.
    if (!isRecord(entry) || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) return undefined
    const executable = entry.mode === '100755'
    const path = text(entry.path)
    if (path === undefined) return undefined
    if (typeof entry.content === 'string' && entry.sha !== undefined) return undefined
    if (typeof entry.content === 'string') entries.push({ path, change: 'new content', executable })
    else if (typeof entry.sha === 'string') entries.push({ path, change: 'stored content', executable })
    else if (entry.sha === null) entries.push({ path, change: 'deleted', executable })
    else return undefined
  }
  return { entries, replacesAll: typeof body.base_tree !== 'string' }
}

/** A box drawn the way GitHub draws one: a gray header, then the content. */
function GitHubBox({ header, children, testId }: { header: ReactNode; children?: ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="mt-3 overflow-hidden rounded-md border border-[#d1d9e0] bg-white text-[#1f2328] dark:border-[#3d444d] dark:bg-[#0d1117] dark:text-[#f0f6fc]"
    >
      <div className="max-h-[160px] overflow-auto break-words border-[#d1d9e0] bg-[#f6f8fa] [&:not(:last-child)]:border-b px-3 py-2 text-xs text-[#59636e] dark:border-[#3d444d] dark:bg-[#151b23] dark:text-[#9198a1]" data-testid={`${testId}-header`}>
        {header}
      </div>
      {children}
    </div>
  )
}

const MUTED = 'text-[#59636e] dark:text-[#9198a1]'

/** A file drawn the way GitHub shows one: its size, then numbered lines. */
export function GitHubBlobView({ blob }: { blob: GitHubBlob }) {
  if (blob.bytes === 0) return <GitHubBox testId="github-blob" header="Empty file." />
  const content = blob.text?.replace(/\n$/, '')
  return (
    <GitHubBox testId="github-blob" header={<span className="font-mono">{content === undefined ? formatFileSize(blob.bytes) : `${blob.lines} ${blob.lines === 1 ? 'line' : 'lines'} · ${formatFileSize(blob.bytes)}`}</span>}>
      {content === undefined ? (
        <p className={`px-3 py-2 text-xs ${MUTED}`} data-testid="github-blob-binary">Binary content, not shown.</p>
      ) : (
        <div className="flex max-h-[220px] overflow-auto py-1 font-mono text-xs leading-5">
          <pre aria-hidden className={`select-none px-3 text-right ${MUTED}`}>
            {Array.from({ length: blob.lines }, (_, i) => i + 1).join('\n')}
          </pre>
          <pre className="pr-3" data-testid="github-blob-text">{content}</pre>
        </div>
      )}
    </GitHubBox>
  )
}

export function GitHubFileCommitView({ commit }: { commit: GitHubFileCommit }) {
  const [summary, ...rest] = commit.message.split('\n')
  const description = rest.join('\n').trim()
  return (
    <>
      <GitHubBox
        testId="github-file-commit"
        header={(
          <>
            {commit.update ? 'Updates the file' : 'Adds the file'} on {commit.branch ? <span className="font-mono">{commit.branch}</span> : 'the default branch'}
            {commit.author && ` · Author: ${commit.author}`}
            {commit.committer && ` · Committer: ${commit.committer}`}
          </>
        )}
      >
        <div className="max-h-[160px] overflow-auto px-3 py-2" data-testid="github-commit-message">
          <p className="break-words text-sm font-semibold">{summary || '(no message)'}</p>
          {description && <p className="mt-1 whitespace-pre-wrap break-words text-xs">{description}</p>}
        </div>
      </GitHubBox>
      <GitHubBlobView blob={commit.file} />
    </>
  )
}

export function GitHubTreeView({ tree }: { tree: GitHubTree }) {
  const count = `${tree.entries.length} ${tree.entries.length === 1 ? 'path' : 'paths'}`
  return (
    <GitHubBox testId="github-tree" header={tree.replacesAll ? `${count}. No base tree, so a commit of this tree has only these paths.` : count}>
      <ul className="max-h-[220px] overflow-auto py-1 text-xs leading-5">
        {tree.entries.map((entry, index) => (
          <li key={index} className="flex justify-between gap-3 px-3">
            <span className="whitespace-pre-wrap break-all font-mono" data-testid="github-tree-path">{entry.path}</span>
            <span className={`shrink-0 ${entry.change === 'deleted' ? 'text-[#d1242f] dark:text-[#f85149]' : MUTED}`}>{entry.executable ? `${entry.change}, executable` : entry.change}</span>
          </li>
        ))}
      </ul>
    </GitHubBox>
  )
}

const repoOf = (targetPath: string, path: RegExp) => {
  const match = path.exec(targetPath)
  return match ? { repo: `${match[1]}/${match[2]}`, file: match[3] } : undefined
}

export function gitHubBlobTitle(targetPath: string) {
  return <>Allow uploading this content to <TitleCode>{repoOf(targetPath, BLOB_PATH)?.repo}</TitleCode>?</>
}

export function gitHubFileCommitTitle(targetPath: string) {
  const { repo, file } = repoOf(targetPath, CONTENTS_PATH) ?? {}
  return <>Allow committing <TitleCode>{file}</TitleCode> to <TitleCode>{repo}</TitleCode>?</>
}

export function gitHubTreeTitle(targetPath: string) {
  return <>Allow preparing a commit&apos;s files in <TitleCode>{repoOf(targetPath, TREE_PATH)?.repo}</TitleCode>?</>
}

export const gitHubBlobCustomPreview: CustomPreview = {
  toolkit: 'github',
  method: 'POST',
  path: BLOB_PATH,
  title: gitHubBlobTitle,
  read: async (requestBody) => {
    const blob = readGitHubBlob(requestBody)
    if (blob) return <GitHubBlobView blob={blob} />
    return isCut(requestBody) ? null : undefined
  },
}

export const gitHubFileCommitCustomPreview: CustomPreview = {
  toolkit: 'github',
  method: 'PUT',
  path: CONTENTS_PATH,
  title: gitHubFileCommitTitle,
  read: async (requestBody) => {
    const commit = readGitHubFileCommit(requestBody)
    if (commit) return <GitHubFileCommitView commit={commit} />
    return isCut(requestBody) ? null : undefined
  },
}

export const gitHubTreeCustomPreview: CustomPreview = {
  toolkit: 'github',
  method: 'POST',
  path: TREE_PATH,
  title: gitHubTreeTitle,
  read: async (requestBody) => {
    const tree = readGitHubTree(requestBody)
    if (tree) return <GitHubTreeView tree={tree} />
    return isCut(requestBody) ? null : undefined
  },
}
