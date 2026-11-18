import { describe, expect, it } from 'vitest'
import { appendAttachedFiles, parseAttachedFiles } from '@shared/lib/utils/attached-files'
import { referenceFor } from './use-team-brain-focus'

describe('referenceFor', () => {
  it('points the agent at a page in its drive, under the drive name it mounts', () => {
    expect(referenceFor({ id: 'eng/releases.md', name: 'releases.md', kind: 'file' }, 'Team Brain')).toEqual({
      type: 'reference',
      id: 'team-brain:eng/releases.md',
      name: 'releases.md',
      path: '/mounts/Team Brain/eng/releases.md',
      kind: 'file',
      from: 'Team Brain',
    })
  })

  it('offers nothing for a path the message would not carry as written', () => {
    const page = (id: string) => ({ id, name: id, kind: 'file' as const })
    // A line break would start a second attached file, a chip marker would be sent as a mention, and an end space is trimmed.
    expect(referenceFor(page('eng/notes\n- other.md'), 'Team Brain')).toBeNull()
    expect(referenceFor(page('eng/notes\r.md'), 'Team Brain')).toBeNull()
    expect(referenceFor(page('eng/notes\u2028.md'), 'Team Brain')).toBeNull()
    expect(referenceFor(page('eng/[[user:alice|Alice]].md'), 'Team Brain')).toBeNull()
    expect(referenceFor(page('eng/notes.md '), 'Team Brain')).toBeNull()
    expect(referenceFor(page('eng/notes.md'), 'Team\nBrain')).toBeNull()
    expect(referenceFor(page('eng/[draft] notes.md'), 'Team Brain')).not.toBeNull()
  })

  it('comes back whole from the message it is sent in', () => {
    const folder = referenceFor({ id: 'eng/release notes', name: 'release notes', kind: 'folder' }, 'Team Brain')!
    expect(parseAttachedFiles(appendAttachedFiles('Is this current?', [folder.path])).attachedFiles).toEqual(['/mounts/Team Brain/eng/release notes/'])
  })

  it('writes a folder as a folder, with its trailing slash', () => {
    expect(referenceFor({ id: 'eng', name: 'eng', kind: 'folder' }, 'Team Brain')).toMatchObject({
      path: '/mounts/Team Brain/eng/',
      kind: 'folder',
    })
  })
})
