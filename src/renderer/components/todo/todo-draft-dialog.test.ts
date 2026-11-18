import { describe, expect, it } from 'vitest'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import type { TodoAttachment } from '@shared/lib/todos/todo-schema'
import { keptAttachments, takeAll } from './todo-draft-dialog'

describe('takeAll', () => {
  it('gives the folders to the first choice only', () => {
    const pending = { current: ['notes', 'docs'] }
    expect(takeAll(pending)).toEqual(['notes', 'docs'])
    expect(takeAll(pending)).toEqual([])
  })
})

describe('keptAttachments', () => {
  const none = () => undefined
  const file = new File(['x'], 'note.txt', { type: 'text/plain' })
  const stored: TodoAttachment = { id: 's', kind: 'file', name: 'old.txt', size: 1, mimeType: 'text/plain', path: '/workspace/uploads/old.txt' }

  it('keeps stored attachments, mounts, and finished uploads, in chip order', () => {
    const chips: Attachment[] = [
      { type: 'mount', id: 'm', folderName: 'notes', hostPath: '/x/notes' },
      { type: 'saved', id: 's', name: 'old.txt', size: 1, mimeType: 'text/plain' },
      { type: 'file', id: 'a', file, upload: { status: 'done', path: '/workspace/uploads/note.txt', agentSlug: 'agent-a' } },
      { type: 'folder', id: 'f', folderName: 'docs', files: [], totalSize: 9 },
    ]
    expect(keptAttachments(chips, [stored], (id) => (id === 'f' ? { path: '/workspace/uploads/docs/' } : undefined))).toEqual([
      { id: 'm', kind: 'mount', name: 'notes', size: 0, mimeType: 'inode/mount', hostPath: '/x/notes' },
      stored,
      { id: 'a', kind: 'file', name: 'note.txt', size: 1, mimeType: 'text/plain', path: '/workspace/uploads/note.txt' },
      { id: 'f', kind: 'folder', name: 'docs', size: 9, mimeType: 'inode/directory', path: '/workspace/uploads/docs/' },
    ])
  })

  it('does not keep an unfinished or failed upload', () => {
    expect(keptAttachments([
      { type: 'file', id: 'a', file, upload: { status: 'uploading', agentSlug: 'agent-a' } },
      { type: 'file', id: 'b', file, error: 'Upload failed' },
    ], [], () => ({ path: '/workspace/uploads/note.txt' }))).toEqual([
      { id: 'a', kind: 'file', name: 'note.txt', size: 1, mimeType: 'text/plain', path: '/workspace/uploads/note.txt' },
    ])
    expect(keptAttachments([{ type: 'file', id: 'a', file, upload: { status: 'uploading', agentSlug: 'agent-a' } }], [], none)).toEqual([])
  })
})
