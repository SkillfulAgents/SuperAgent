import { describe, expect, it } from 'vitest'
import { parseUserMessageParts } from './user-message-parts'

describe('parseUserMessageParts', () => {
  it('lifts a sender prefix', () => {
    expect(parseUserMessageParts('\\[Dana]: hello')).toEqual({
      sender: 'Dana',
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
      attachedFiles: [],
      mountedFolders: [{ containerPath: '/mounts/project', hostPath: '/Users/joe/project' }],
      text: 'Hello',
    })
  })

  it('leaves plain text untouched', () => {
    expect(parseUserMessageParts('just a message')).toEqual({
      sender: null,
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
      attachedFiles: ['/workspace/uploads/file.md'],
      mountedFolders: [{ containerPath: '/mounts/src', hostPath: '/host/src' }],
      text: 'Check these',
    })
  })
})
