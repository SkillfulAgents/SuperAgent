// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { requestBodyPreview } from '@shared/lib/proxy/review-display'
import { customPreviewFor } from './custom-previews'
import {
  gitHubBlobCustomPreview, gitHubBlobTitle, gitHubFileCommitCustomPreview, gitHubFileCommitTitle, gitHubTreeCustomPreview, readGitHubBlob, readGitHubFileCommit,
  readGitHubTree,
} from './github'

/** The request body as the card gets it: pretty-printed JSON when it parses, cut at 64,000 characters. */
const asCard = (body: unknown) => requestBodyPreview(new TextEncoder().encode(JSON.stringify(body)).buffer) ?? ''

const SOURCE = 'export function add(a, b) {\n  return a + b\n}\n'

describe('a GitHub blob on the card', () => {
  it('shows base64 content as the numbered lines of the file, under the repository it goes to', async () => {
    expect(customPreviewFor('github', 'POST', 'repos/acme/api/git/blobs')).toBe(gitHubBlobCustomPreview)
    render(<>{gitHubBlobTitle('repos/acme/api/git/blobs')}</>)
    expect(document.body.textContent).toBe('Allow uploading this content to acme/api?')
    render(<>{await gitHubBlobCustomPreview.read(asCard({ content: Buffer.from(SOURCE).toString('base64'), encoding: 'base64' }))}</>)
    expect(screen.getByTestId('github-blob-header').textContent).toBe('3 lines · 45 B')
    expect(screen.getByTestId('github-blob-text').textContent).toBe(SOURCE.replace(/\n$/, ''))
  })

  it('reads content sent as text when the body names no encoding', () => {
    expect(readGitHubBlob(asCard({ content: SOURCE }))).toEqual({ text: SOURCE, lines: 3, bytes: 45 })
  })

  it('says the content is binary instead of drawing it', async () => {
    render(<>{await gitHubBlobCustomPreview.read(asCard({ content: Buffer.from([0, 1, 2, 3, 4, 5, 6]).toString('base64'), encoding: 'base64' }))}</>)
    expect(screen.getByTestId('github-blob-header').textContent).toBe('7 B')
    expect(screen.getByTestId('github-blob-binary').textContent).toBe('Binary content, not shown.')
  })

  it('says an empty file is empty', async () => {
    render(<>{await gitHubBlobCustomPreview.read(asCard({ content: '' }))}</>)
    expect(screen.getByTestId('github-blob-header').textContent).toBe('Empty file.')
  })

  it('draws nothing for a direction control sent escaped in a body the card did not re-serialize', () => {
    const body = `{"pad": "${'界'.repeat(22_000)}", "tree": [{"path": "src/\\u202edm.EMDAER", "mode": "100644", "type": "blob", "sha": "s1"}]}`
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(64_000)
    expect(readGitHubTree(requestBodyPreview(new TextEncoder().encode(body).buffer) ?? '')).toBeUndefined()
  })

  it('draws nothing for text with direction controls, which would display differently from what GitHub stores', () => {
    expect(readGitHubBlob(asCard({ content: 'const ok = true // \u202e } ;eslaf = ko' }))).toBeUndefined()
  })

  it.each([
    ['a copy the card cut short', asCard({ content: Buffer.from('x'.repeat(60_000)).toString('base64'), encoding: 'base64' })],
    ['an encoding GitHub does not take', asCard({ content: 'abc', encoding: 'latin1' })],
    ['content that does not decode', asCard({ content: '%%%', encoding: 'base64' })],
  ])('draws nothing for %s, leaving the raw request', (_case, requestBody) => {
    expect(readGitHubBlob(requestBody)).toBeUndefined()
  })
})

describe('a GitHub file commit on the card', () => {
  const body = { message: 'Hash session tokens\n\nStops storing them in plain text.', content: Buffer.from(SOURCE).toString('base64'), branch: 'feat/hash', sha: 'abc123' }

  it('shows the branch, the message and the file', async () => {
    expect(customPreviewFor('github', 'PUT', 'repos/acme/api/contents/src/auth.ts')).toBe(gitHubFileCommitCustomPreview)
    render(<>{gitHubFileCommitTitle('repos/acme/api/contents/src/auth.ts')}</>)
    expect(document.body.textContent).toBe('Allow committing src/auth.ts to acme/api?')
    render(<>{await gitHubFileCommitCustomPreview.read(asCard(body))}</>)
    expect(screen.getByTestId('github-file-commit-header').textContent).toBe('Updates the file on feat/hash')
    expect(screen.getByTestId('github-commit-message').textContent).toBe('Hash session tokensStops storing them in plain text.')
    expect(screen.getByTestId('github-blob-text').textContent).toBe(SOURCE.replace(/\n$/, ''))
  })

  it('keeps today\'s card for a path with direction controls, which could display as another file name', () => {
    expect(customPreviewFor('github', 'PUT', 'repos/acme/api/contents/src/\u202edm.EMDAER')).toBeUndefined()
  })

  it('names the default branch when the body names none, and a new file when it has no sha', () => {
    expect(readGitHubFileCommit(asCard({ message: 'Add', content: Buffer.from('x').toString('base64') }))).toMatchObject({ branch: undefined, update: false })
  })

  it('names the author and committer the call sets', async () => {
    render(<>{await gitHubFileCommitCustomPreview.read(asCard({ ...body, author: { name: 'Dana', email: 'dana@acme.com' }, committer: { name: 'Bot' } }))}</>)
    expect(screen.getByTestId('github-file-commit-header').textContent).toBe('Updates the file on feat/hash · Author: Dana <dana@acme.com> · Committer: Bot')
  })

  it.each([
    ['a branch', { branch: 'feat\u2066' }],
    ['an author', { author: { name: 'Dana\u2066', email: 'dana@acme.com' } }],
  ])('draws nothing when %s holds direction controls, rather than showing it as absent', (_case, extra) => {
    expect(readGitHubFileCommit(asCard({ ...body, ...extra }))).toBeUndefined()
  })

  it('shows the date a commit sets for its author', () => {
    expect(readGitHubFileCommit(asCard({ ...body, author: { name: 'Dana', email: 'd@acme.com', date: '2001-01-01T00:00:00Z' } }))?.author).toBe('Dana <d@acme.com> on 2001-01-01T00:00:00Z')
  })

  it('draws nothing without a message, since GitHub refuses the call', () => {
    expect(readGitHubFileCommit(asCard({ content: Buffer.from('x').toString('base64') }))).toBeUndefined()
  })
})

describe('a GitHub tree on the card', () => {
  it('lists each path and where its content comes from', async () => {
    expect(customPreviewFor('github', 'POST', 'repos/acme/api/git/trees')).toBe(gitHubTreeCustomPreview)
    render(<>{await gitHubTreeCustomPreview.read(asCard({
      base_tree: 'b1',
      tree: [
        { path: 'src/auth.ts', mode: '100644', type: 'blob', sha: 's1' },
        { path: 'README.md', mode: '100644', type: 'blob', content: '# api' },
        { path: 'old.ts', mode: '100644', type: 'blob', sha: null },
      ],
    }))}</>)
    expect(screen.getByTestId('github-tree-header').textContent).toBe('3 paths')
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['src/auth.tsstored content', 'README.mdnew content', 'old.tsdeleted'])
  })

  it('marks an executable file', () => {
    expect(readGitHubTree(asCard({ base_tree: 'b1', tree: [{ path: 'run.sh', mode: '100755', type: 'blob', sha: 's1' }] }))?.entries).toEqual([{ path: 'run.sh', change: 'stored content', executable: true }])
  })

  it('says a tree with no base keeps only its own paths', () => {
    expect(readGitHubTree(asCard({ tree: [{ path: 'a', mode: '100644', type: 'blob', content: 'a' }] }))?.replacesAll).toBe(true)
  })

  it.each([
    ['a folder', { path: 'lib', mode: '040000', type: 'tree', sha: 's1' }],
    ['a submodule', { path: 'vendor/x', mode: '160000', type: 'commit', sha: 's1' }],
    ['a symlink', { path: 'link', mode: '120000', type: 'blob', content: '/etc/passwd' }],
    ['new content and a sha at once', { path: 'a.ts', mode: '100644', type: 'blob', content: 'x', sha: null }],
  ])('draws nothing for a tree with %s, which would show as an ordinary file', (_case, entry) => {
    expect(readGitHubTree(asCard({ base_tree: 'b1', tree: [entry] }))).toBeUndefined()
  })

  it('draws nothing for an entry it cannot place', () => {
    expect(readGitHubTree(asCard({ base_tree: 'b1', tree: [{ mode: '100644', type: 'blob', sha: 's1' }] }))).toBeUndefined()
  })
})

describe('GitHub content the card cut short', () => {
  it('keeps the title alone, for each card that reads content', async () => {
    const cut = asCard({ message: 'Add', content: Buffer.from('x'.repeat(60_000)).toString('base64') })
    expect(cut.endsWith('…')).toBe(true)
    for (const preview of [gitHubFileCommitCustomPreview, gitHubBlobCustomPreview, gitHubTreeCustomPreview]) expect(await preview.read(cut)).toBeNull()
  })
})
