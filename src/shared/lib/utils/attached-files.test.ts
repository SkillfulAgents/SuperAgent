import { describe, it, expect } from 'vitest'
import { appendAttachedFiles, parseAttachedFiles, appendMountedFolders, parseMountedFolders } from './attached-files'

describe('appendAttachedFiles', () => {
  it('appends files to a message with content', () => {
    const result = appendAttachedFiles('Hello', ['/workspace/uploads/file.md'])
    expect(result).toBe('Hello\n\n[Attached files:]\n- /workspace/uploads/file.md')
  })

  it('creates a files-only message when content is empty', () => {
    const result = appendAttachedFiles('', ['/workspace/uploads/file.md'])
    expect(result).toBe('[Attached files:]\n- /workspace/uploads/file.md')
  })

  it('handles multiple files', () => {
    const result = appendAttachedFiles('Hi', ['/workspace/uploads/a.md', '/workspace/uploads/b.ts'])
    expect(result).toBe('Hi\n\n[Attached files:]\n- /workspace/uploads/a.md\n- /workspace/uploads/b.ts')
  })

  it('returns message unchanged when no files', () => {
    expect(appendAttachedFiles('Hello', [])).toBe('Hello')
  })
})

describe('parseAttachedFiles', () => {
  it('parses files from a message with content', () => {
    const text = 'Hello\n\n[Attached files:]\n- /workspace/uploads/file.md'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('Hello')
    expect(result.attachedFiles).toEqual(['/workspace/uploads/file.md'])
  })

  it('parses files-only message', () => {
    const text = '[Attached files:]\n- /workspace/uploads/file.md'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('')
    expect(result.attachedFiles).toEqual(['/workspace/uploads/file.md'])
  })

  it('parses multiple files', () => {
    const text = 'Hi\n\n[Attached files:]\n- /workspace/uploads/a.md\n- /workspace/uploads/b.ts'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('Hi')
    expect(result.attachedFiles).toEqual(['/workspace/uploads/a.md', '/workspace/uploads/b.ts'])
  })

  it('handles blank line between marker and files', () => {
    const text = 'Hi\n\n[Attached files:]\n\n- /workspace/uploads/file.md'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('Hi')
    expect(result.attachedFiles).toEqual(['/workspace/uploads/file.md'])
  })

  it('returns original text when no marker present', () => {
    const text = 'Just a normal message'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('Just a normal message')
    expect(result.attachedFiles).toEqual([])
  })

  it('roundtrips with appendAttachedFiles', () => {
    const message = 'What is in this file?'
    const files = ['/workspace/uploads/1772936479165-agent-proxy-scope-policy.md', '/workspace/uploads/1772936479166-providers.ts']
    const encoded = appendAttachedFiles(message, files)
    const { cleanText, attachedFiles } = parseAttachedFiles(encoded)
    expect(cleanText).toBe(message)
    expect(attachedFiles).toEqual(files)
  })

  it('roundtrips with empty message', () => {
    const files = ['/workspace/uploads/file.md']
    const encoded = appendAttachedFiles('', files)
    const { cleanText, attachedFiles } = parseAttachedFiles(encoded)
    expect(cleanText).toBe('')
    expect(attachedFiles).toEqual(files)
  })

  it('reads no block from a marker followed by more text', () => {
    const message = '[Attached files:]\n- /workspace/uploads/a.png\n\nthis list was pasted, not attached'
    expect(parseAttachedFiles(message)).toEqual({ cleanText: message, attachedFiles: [] })
  })

  it('lifts only the last block when an earlier one was pasted as text', () => {
    const pasted = appendAttachedFiles('The bubble used to show:', ['/workspace/uploads/example.png'])
    const message = `${pasted}\n\nlike that`
    const { cleanText, attachedFiles } = parseAttachedFiles(appendAttachedFiles(message, ['/workspace/uploads/real.png']))
    expect(cleanText).toBe(message)
    expect(attachedFiles).toEqual(['/workspace/uploads/real.png'])
  })

  it('keeps a message that ends on a bare marker', () => {
    const message = 'The header reads\n\n[Attached files:]\n'
    expect(parseAttachedFiles(message)).toEqual({ cleanText: message, attachedFiles: [] })
  })
})

describe('appendMountedFolders', () => {
  it('appends mounts to a message with content', () => {
    const result = appendMountedFolders('Hello', [{ containerPath: '/mounts/project', hostPath: '/Users/joe/project' }])
    expect(result).toBe('Hello\n\n[Attached drives (read-write):]\n- /mounts/project (from /Users/joe/project)')
  })

  it('creates a mount-only message when content is empty', () => {
    const result = appendMountedFolders('', [{ containerPath: '/mounts/src', hostPath: '/tmp/src' }])
    expect(result).toBe('[Attached drives (read-write):]\n- /mounts/src (from /tmp/src)')
  })

  it('handles multiple mounts', () => {
    const result = appendMountedFolders('Hi', [
      { containerPath: '/mounts/a', hostPath: '/host/a' },
      { containerPath: '/mounts/b', hostPath: '/host/b' },
    ])
    expect(result).toBe('Hi\n\n[Attached drives (read-write):]\n- /mounts/a (from /host/a)\n- /mounts/b (from /host/b)')
  })

  it('returns message unchanged when mounts array is empty', () => {
    expect(appendMountedFolders('Hello', [])).toBe('Hello')
  })
})

describe('parseMountedFolders', () => {
  it('still parses the tag on messages sent before drives', () => {
    const text = 'Hello\n\n[Mounted folders (read-write):]\n- /mounts/project (from /Users/joe/project)'
    const result = parseMountedFolders(text)
    expect(result.cleanText).toBe('Hello')
    expect(result.mountedFolders).toEqual([{ containerPath: '/mounts/project', hostPath: '/Users/joe/project' }])
  })

  it('parses mount-only message', () => {
    const text = '[Attached drives (read-write):]\n- /mounts/src (from /tmp/src)'
    const result = parseMountedFolders(text)
    expect(result.cleanText).toBe('')
    expect(result.mountedFolders).toEqual([{ containerPath: '/mounts/src', hostPath: '/tmp/src' }])
  })

  it('returns original text when no marker present', () => {
    const result = parseMountedFolders('Just a normal message')
    expect(result.cleanText).toBe('Just a normal message')
    expect(result.mountedFolders).toEqual([])
  })

  it('roundtrips with appendMountedFolders', () => {
    const message = 'Work on this project'
    const mounts = [
      { containerPath: '/mounts/app', hostPath: '/Users/joe/app' },
      { containerPath: '/mounts/lib', hostPath: '/Users/joe/lib' },
    ]
    const encoded = appendMountedFolders(message, mounts)
    const { cleanText, mountedFolders } = parseMountedFolders(encoded)
    expect(cleanText).toBe(message)
    expect(mountedFolders).toEqual(mounts)
  })

  it('roundtrips with empty message', () => {
    const mounts = [{ containerPath: '/mounts/data', hostPath: '/host/data' }]
    const encoded = appendMountedFolders('', mounts)
    const { cleanText, mountedFolders } = parseMountedFolders(encoded)
    expect(cleanText).toBe('')
    expect(mountedFolders).toEqual(mounts)
  })

  it('coexists with attached files block (mounts appended first)', () => {
    const msg = 'Check these'
    // The composer appends mounts, then files, so each parser lifts the block that ends the text.
    const withMounts = appendMountedFolders(msg, [{ containerPath: '/mounts/src', hostPath: '/host/src' }])
    const withBoth = appendAttachedFiles(withMounts, ['/workspace/uploads/file.md'])

    const { cleanText: afterFiles, attachedFiles } = parseAttachedFiles(withBoth)
    expect(attachedFiles).toEqual(['/workspace/uploads/file.md'])

    // Parse mounted folders from the remainder
    const { cleanText, mountedFolders } = parseMountedFolders(afterFiles)
    expect(cleanText).toBe('Check these')
    expect(mountedFolders).toEqual([{ containerPath: '/mounts/src', hostPath: '/host/src' }])
  })

  it('reads an old-tag block after a quoted new marker', () => {
    const message = 'It now says [Attached drives (read-write):] instead'
    const text = `${message}\n\n[Mounted folders (read-write):]\n- /mounts/src (from /host/src)`
    expect(parseMountedFolders(text)).toEqual({ cleanText: message, mountedFolders: [{ containerPath: '/mounts/src', hostPath: '/host/src' }] })
  })

  it('keeps a marker quoted in the message as text', () => {
    const message = 'Line 2: > "Shows [Attached drives (read-write):] under the text"\nfix'
    const mounts = [{ containerPath: '/mounts/src', hostPath: '/host/src' }]
    const { cleanText, mountedFolders } = parseMountedFolders(appendMountedFolders(message, mounts))
    expect(cleanText).toBe(message)
    expect(mountedFolders).toEqual(mounts)
  })
})
