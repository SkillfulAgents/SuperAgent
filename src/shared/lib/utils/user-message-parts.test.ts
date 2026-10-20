import { describe, expect, it } from 'vitest'
import { parseUserMessageParts } from './user-message-parts'

describe('parseUserMessageParts', () => {
  it('lifts a sender prefix', () => {
    expect(parseUserMessageParts('\\[Dana]: hello')).toEqual({
      sender: 'Dana',
      mentions: [],
      silent: false,
      attachedFiles: [],
      mountedFolders: [],
      text: 'hello',
    })
  })

  it('lifts attached files out of the text', () => {
    expect(parseUserMessageParts(
      'Hello\n\n[Attached files:]\n- /workspace/uploads/file.md',
    )).toEqual({
      sender: null,
      mentions: [],
      silent: false,
      attachedFiles: ['/workspace/uploads/file.md'],
      mountedFolders: [],
      text: 'Hello',
    })
  })

  it('lifts mounted folders out of the text', () => {
    expect(parseUserMessageParts(
      'Hello\n\n[Mounted folders (read-write):]\n- /mounts/project (from /Users/joe/project)',
    )).toEqual({
      sender: null,
      mentions: [],
      silent: false,
      attachedFiles: [],
      mountedFolders: [{ containerPath: '/mounts/project', hostPath: '/Users/joe/project' }],
      text: 'Hello',
    })
  })

  it('leaves plain text untouched', () => {
    expect(parseUserMessageParts('just a message')).toEqual({
      sender: null,
      mentions: [],
      silent: false,
      attachedFiles: [],
      mountedFolders: [],
      text: 'just a message',
    })
  })

  it('lifts sender, files, and folders from one message', () => {
    const raw = [
      '\\[Dana]: Check these',
      '',
      '[Mounted folders (read-write):]',
      '- /mounts/src (from /host/src)',
      '',
      '[Attached files:]',
      '- /workspace/uploads/file.md',
    ].join('\n')

    expect(parseUserMessageParts(raw)).toEqual({
      sender: 'Dana',
      mentions: [],
      silent: false,
      attachedFiles: ['/workspace/uploads/file.md'],
      mountedFolders: [{ containerPath: '/mounts/src', hostPath: '/host/src' }],
      text: 'Check these',
    })
  })

  it('lifts the mentions block, before the files that follow it', () => {
    const raw = [
      '\\[Dana]: @Mike Smith look at this',
      '',
      '[Attached files:]',
      '- /workspace/uploads/file.md',
      '',
      '[Mentioned:]',
      '- @Mike Smith: teammate, mike@acme.com (user id u_mike1)',
      '(This message only notifies the teammates it tags. It is not a request to you, so do not act on it.)',
    ].join('\n')

    expect(parseUserMessageParts(raw)).toEqual({
      sender: 'Dana',
      mentions: [{ kind: 'user', id: 'u_mike1', name: 'Mike Smith', email: 'mike@acme.com' }],
      silent: true,
      attachedFiles: ['/workspace/uploads/file.md'],
      mountedFolders: [],
      text: '@Mike Smith look at this',
    })
  })
})
