import { describe, expect, it } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { depthOf, destinationOf, multistatus, statusOf, volumePathOf } from './webdav'

const base = '/api/volumes/v_1'

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof WorkspaceFileError) return error.code
    throw error
  }
  throw new Error('expected a WorkspaceFileError')
}

describe('volumePathOf', () => {
  it('reads the decoded path after the volume base, the root included', () => {
    expect(volumePathOf(`${base}/team%20notes/a.txt`, base)).toBe('team notes/a.txt')
    expect(volumePathOf(`${base}/docs/`, base)).toBe('docs')
    expect(volumePathOf(base, base)).toBe('')
  })

  it('normalizes the path, and refuses one that climbs out of the volume', () => {
    expect(volumePathOf(`${base}/a/./b/../c.txt`, base)).toBe('a/c.txt')
    expect(codeOf(() => volumePathOf(`${base}/a/../..`, base))).toBe('invalid-path')
    expect(codeOf(() => volumePathOf(`${base}/%2E%2E/x`, base))).toBe('invalid-path')
    expect(codeOf(() => volumePathOf(`${base}/a%5Cb`, base))).toBe('invalid-path')
  })

  it('refuses a path under another volume', () => {
    expect(codeOf(() => volumePathOf('/api/volumes/v_10/a.txt', base))).toBe('outside-workspace')
  })
})

describe('destinationOf', () => {
  it('reads a destination in the same volume, and refuses one in another', () => {
    expect(destinationOf(`http://host.docker.internal:47891${base}/b.txt`, base)).toBe('b.txt')
    expect(codeOf(() => destinationOf('http://host.docker.internal:47891/api/volumes/v_2/b.txt', base))).toBe('outside-workspace')
    expect(codeOf(() => destinationOf(`http://host.docker.internal:47891${base}/a\\b`, base))).toBe('invalid-path')
  })
})

describe('depthOf', () => {
  it('allows depth 0 and 1 and refuses infinity', () => {
    expect(depthOf('0')).toBe(0)
    expect(depthOf('1')).toBe(1)
    expect(codeOf(() => depthOf('infinity'))).toBe('not-accessible')
  })
})

describe('multistatus', () => {
  it('describes folders and files the way rclone parses them', () => {
    const body = multistatus(base, [
      { path: '', entry: { name: '', kind: 'directory', size: 0, mtimeMs: 0 } },
      { path: 'a b.txt', entry: { name: 'a b.txt', kind: 'file', size: 5, mtimeMs: Date.UTC(2026, 8, 29, 20) } },
    ])
    expect(body).toContain(`<d:href>${base}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>`)
    expect(body).toContain(`<d:href>${base}/a%20b.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>5</d:getcontentlength>`)
    expect(body).toContain('<d:getlastmodified>Tue, 29 Sep 2026 20:00:00 GMT</d:getlastmodified>')
  })
})

describe('statusOf', () => {
  it('answers MKCOL on an existing folder with 405 and a missing parent with 409', () => {
    expect(statusOf('MKCOL', 'd', new WorkspaceFileError('already-exists'))).toBe(405)
    expect(statusOf('PUT', 'a.txt', new WorkspaceFileError('not-found'))).toBe(409)
    expect(statusOf('PUT', 'a.txt', new WorkspaceFileError('not-a-directory'))).toBe(409)
    expect(statusOf('MKCOL', 'd', new WorkspaceFileError('not-a-directory'))).toBe(409)
    expect(statusOf('MOVE', 'a.txt', new WorkspaceFileError('not-a-directory'))).toBe(409)
    expect(statusOf('MOVE', 'a.txt', new WorkspaceFileError('not-found'))).toBe(404)
    expect(statusOf('GET', 'a.txt', new WorkspaceFileError('not-a-directory'))).toBe(404)
    expect(statusOf('GET', 'a.txt', new WorkspaceFileError('not-found'))).toBe(404)
    expect(statusOf('PROPFIND', 'a.txt', new WorkspaceFileError('not-accessible'))).toBe(403)
  })

  it('answers PUT onto a folder with 405', () => {
    expect(statusOf('PUT', 'd', new WorkspaceFileError('not-a-file'))).toBe(405)
    expect(statusOf('GET', 'd', new WorkspaceFileError('not-a-file'))).toBe(404)
  })

  it('never answers 404 at the root, so rclone never mounts it as an empty folder', () => {
    expect(statusOf('PROPFIND', '', new WorkspaceFileError('not-found'))).toBe(403)
    expect(statusOf('GET', '', new WorkspaceFileError('not-a-file'))).toBe(403)
    expect(statusOf('PROPFIND', 'a.txt', new WorkspaceFileError('not-found'))).toBe(404)
  })
})
