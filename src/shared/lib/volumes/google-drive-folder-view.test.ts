import { describe, expect, it } from 'vitest'
import { driveFileSchema } from './google-drive-schema'
import { driveNameOf, folderView, nameTaken, writeTarget } from './google-drive-folder-view'

const at = (second: number) => `2026-10-07T12:00:${String(second).padStart(2, '0')}Z`
const file = (id: string, name: string, mimeType = 'text/plain', fields: Record<string, unknown> = {}) =>
  driveFileSchema.parse({ id, name, mimeType, modifiedTime: at(0), ...(mimeType.startsWith('application/vnd.google-apps.') ? {} : { size: '10' }), ...fields })
const doc = (id: string, name: string, fields: Record<string, unknown> = {}) => file(id, name, 'application/vnd.google-apps.document', fields)
const folder = (id: string, name: string) => file(id, name, 'application/vnd.google-apps.folder')
const view = (...children: ReturnType<typeof file>[]) => folderView(children, () => false)
const names = (...children: ReturnType<typeof file>[]) => view(...children).entries.map(entry => entry.name)

describe('Google Drive folder view', () => {
  it('hides what cannot be served, warns about shortcuts and dot names, and maps slashes for display only', () => {
    const { entries, warnings } = view(
      file('t', 'gone.txt', 'text/plain', { trashed: true }), file('s', 'Link', 'application/vnd.google-apps.shortcut'),
      file('f', 'Survey', 'application/vnd.google-apps.form'), file('m', 'Map', 'application/vnd.google-apps.map'),
      file('d1', '.'), file('d2', '..'), file('ab', 'a/b.txt'), folder('sub', 'Sub'),
      doc('locked', 'Locked', { capabilities: { canDownload: false } }),
    )
    expect(entries.map(entry => [entry.name, entry.file.name])).toEqual([['a／b.txt', 'a/b.txt'], ['Sub', 'Sub']])
    expect(warnings).toEqual([expect.stringContaining('shortcut Link'), expect.stringContaining('named .'), expect.stringContaining('named ..'), expect.stringContaining('downloads are blocked')])
  })

  it('gives Google files their export extension and suffixes only an export that clashes with a real entry, case-sensitively', () => {
    expect(names(doc('d', 'Plan'), file('s', 'Budget', 'application/vnd.google-apps.spreadsheet'), file('p', 'Deck', 'application/vnd.google-apps.presentation'), file('g', 'Sketch', 'application/vnd.google-apps.drawing')))
      .toEqual(['Plan.md', 'Budget.xlsx', 'Deck.pptx'])
    expect(names(doc('d', 'Plan'), file('r', 'Plan.md'), doc('l', 'plan'), folder('f', 'plan.md'), doc('t', 'Plan/2'), file('u', 'Plan／2.md')))
      .toEqual(['Plan (Google Doc).md', 'Plan.md', 'plan (Google Doc).md', 'plan.md', 'Plan／2 (Google Doc).md', 'Plan／2.md'])
  })

  it('keeps the newest of a name used twice and warns about the rest', () => {
    const { entries, warnings } = view(file('old', 'notes.txt'), file('new', 'notes.txt', 'text/plain', { modifiedTime: at(5) }))
    expect(entries.map(entry => entry.file.id)).toEqual(['new'])
    expect(warnings).toEqual([expect.stringContaining('notes.txt (old)')])
  })

  it('never lets a real file hide a Google file: a taken suffixed name falls back to one with the ID', () => {
    const plan = doc('d1x2y3z', 'Plan')
    const { entries } = view(plan, file('r', 'Plan.md'), file('x', 'Plan (Google Doc).md', 'text/plain', { modifiedTime: at(9) }))
    expect(entries.map(entry => entry.name)).toEqual(['Plan (Google Doc d1x2y).md', 'Plan.md', 'Plan (Google Doc).md'])
    const shown = entries.find(entry => entry.file.id === 'd1x2y3z')
    expect(shown && driveNameOf(shown, 'Roadmap (Google Doc d1x2y).md')).toBe('Roadmap')
    const again = view(plan, file('r', 'Plan.md'), file('x', 'Plan (Google Doc).md'), file('y', 'Plan (Google Doc d1x2y).md'))
    expect(again.entries.map(entry => entry.name)).toContain('Plan (Google Doc d1x2y3z).md')
  })

  it('drops a Google file whose export is known to be too large', () => {
    const { entries, warnings } = folderView([doc('big', 'Huge'), doc('ok', 'Small')], file => file.id === 'big')
    expect(entries.map(entry => entry.name)).toEqual(['Small.md'])
    expect(warnings).toEqual([expect.stringContaining('exceeds 10 MB')])
  })

  it('updates a visible file, converts a Google file\'s copy back into it, refuses a visible folder, and creates otherwise', () => {
    const children = [doc('d', 'Plan'), file('n', 'notes.txt'), file('s', 'Link', 'application/vnd.google-apps.shortcut'), folder('f', 'Sub'), file('h', 'twice.txt'), file('h2', 'twice.txt', 'text/plain', { modifiedTime: at(1) })]
    const { entries } = view(...children)
    const target = (name: string) => writeTarget(entries, name)
    expect(target('notes.txt')).toEqual({ kind: 'update', id: 'n' })
    expect(target('twice.txt')).toEqual({ kind: 'update', id: 'h2' })
    expect(target('Sub')).toEqual({ kind: 'refused' })
    expect(target('Plan')).toEqual({ kind: 'create' })
    expect(target('Link')).toEqual({ kind: 'create' })
    expect(target('Plan.md')).toEqual({ kind: 'update', id: 'd', convertFrom: 'text/markdown' })
    expect(target('fresh.txt')).toEqual({ kind: 'create' })
  })

  it('counts hidden entries and shown export names as taken, except the entry being renamed', () => {
    const children = [doc('d', 'Plan'), file('s', 'Link', 'application/vnd.google-apps.shortcut'), file('n', 'notes.txt')]
    const { entries } = view(...children)
    expect(nameTaken(children, entries, 'Link')).toBe(true)
    expect(nameTaken(children, entries, 'Plan')).toBe(true)
    expect(nameTaken(children, entries, 'Plan.md')).toBe(true)
    expect(nameTaken(children, entries, 'Plan', 'Plan.md', 'd')).toBe(false)
    expect(nameTaken(children, entries, 'fresh')).toBe(false)
  })

  it('renames an export by stripping its suffix and extension, which the new name must keep', () => {
    const [plan, notes] = view(doc('d', 'Plan'), file('n', 'notes.txt')).entries
    expect(driveNameOf(notes, 'other.bin')).toBe('other.bin')
    expect(driveNameOf(plan, 'Roadmap.md')).toBe('Roadmap')
    expect(driveNameOf(plan, 'Roadmap (Google Doc).md')).toBe('Roadmap')
    expect(driveNameOf(plan, 'Roadmap.txt')).toBeNull()
    expect(driveNameOf(plan, '.md')).toBeNull()
  })
})
