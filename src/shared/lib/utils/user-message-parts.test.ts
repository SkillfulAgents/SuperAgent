import { describe, expect, it } from 'vitest'
import { parseUserMessageParts } from './user-message-parts'

describe('parseUserMessageParts', () => {
  it('lifts a sender prefix only when readOnly', () => {
    const raw = '\\[Dana]: hello'
    expect(parseUserMessageParts(raw, { readOnly: true })).toEqual({
      sender: 'Dana',
      attachedFiles: [],
      mountedFolders: [],
      text: 'hello',
    })
    expect(parseUserMessageParts(raw, { readOnly: false })).toEqual({
      sender: null,
      attachedFiles: [],
      mountedFolders: [],
      text: raw,
    })
  })

  it('lifts attached files out of the text', () => {
    expect(parseUserMessageParts(
      'Hello\n\n[Attached files:]\n- /workspace/uploads/file.md',
      { readOnly: false },
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
      { readOnly: false },
    )).toEqual({
      sender: null,
      attachedFiles: [],
      mountedFolders: [{ containerPath: '/mounts/project', hostPath: '/Users/joe/project' }],
      text: 'Hello',
    })
  })

  it('leaves plain text untouched', () => {
    expect(parseUserMessageParts('just a message', { readOnly: false })).toEqual({
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

    expect(parseUserMessageParts(raw, { readOnly: true })).toEqual({
      sender: 'Dana',
      attachedFiles: ['/workspace/uploads/file.md'],
      mountedFolders: [{ containerPath: '/mounts/src', hostPath: '/host/src' }],
      text: 'Check these',
    })
  })
})
