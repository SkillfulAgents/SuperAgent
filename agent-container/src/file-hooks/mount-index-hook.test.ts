import { describe, it, expect, vi } from 'vitest'
import { MountIndexFileHook, mountIndexCommandHint } from './mount-index-hook'

vi.mock('../volume-mounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../volume-mounts')>()),
  mountedVolumeIndexes: () => [
    { path: '/mounts/notes', index: { text: '- a.md', truncated: false } },
    { path: '/mounts/Team (old)', index: { text: '- a.md', truncated: false } },
  ],
}))

const hook = new MountIndexFileHook()
const notesHint = 'Drive index: "/mounts/notes/INDEX.md". Update the index if this change makes an entry wrong or missing.'
const teamHint = 'Drive index: "/mounts/Team (old)/INDEX.md". Update the index if this change makes an entry wrong or missing.'

describe('MountIndexFileHook', () => {
  it.each([
    ['/mounts/notes/a.md', true],
    ['/mounts/notes/sub/b.md', true],
    ['/mounts/notes/INDEX.md', false],
    ['/mounts/notes-old/a.md', false],
    ['/mounts/other/a.md', false],
    ['/workspace/a.md', false],
  ])('matches(%s) is %s', (filePath, expected) => {
    expect(hook.matches(filePath)).toBe(expected)
  })

  it('names the index on write and edit', () => {
    expect(hook.onWrite('/mounts/notes/a.md')).toEqual({ warning: notesHint })
    expect(hook.onEdit('/mounts/notes/a.md')).toEqual({ warning: notesHint })
  })
})

describe('mountIndexCommandHint', () => {
  it.each([
    ['mv /mounts/notes/a.md /mounts/notes/old/', notesHint],
    ['cd /workspace && /bin/rm -f /mounts/notes/a.md', notesHint],
    ['mv draft.md "/mounts/notes"', notesHint],
    ['find /mounts/notes -name "*.tmp" -delete', notesHint],
    ['ls /mounts/notes/*.tmp | xargs rm', notesHint],
    ['rm /workspace/mounts/notes/a.md', undefined],
    ['rm "/mounts/Team (old)/a.md"', teamHint],
    ['rm /mounts/Team\\ \\(old\\)/a.md', teamHint],
    ['tee -a /mounts/notes/INDEX.md', undefined],
    ['cp /tmp/index.md "/mounts/notes/INDEX.md"', undefined],
    ['mv /mounts/notes/a.md /mounts/notes/b.md && tee /mounts/notes/INDEX.md', notesHint],
    ['ls /mounts/notes', undefined],
    ['rm /mounts/notes-old/a.md', undefined],
    ['rm /workspace/a.md', undefined],
  ])('hint for %s', (command, expected) => {
    expect(mountIndexCommandHint(command)).toBe(expected)
  })

  it('names every indexed folder a command touches', () => {
    expect(mountIndexCommandHint('mv /mounts/notes/a.md "/mounts/Team (old)/"')).toBe(
      'Drive index: "/mounts/notes/INDEX.md", "/mounts/Team (old)/INDEX.md". Update the index if this change makes an entry wrong or missing.')
  })
})
