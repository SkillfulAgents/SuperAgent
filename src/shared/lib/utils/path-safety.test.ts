import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import path from 'path'
import { isPathWithinDir, assertPathWithinDir, isRealPathWithinDir, sanitizeUploadFilename } from './path-safety'

// ---------------------------------------------------------------------------
// Path containment guard (SUP-200 generalization). The motivating bug: a bare
// `resolved.startsWith(baseDir)` check lets a SIBLING directory that shares the
// base's string prefix slip through. These tests pin the correct behavior.
// ---------------------------------------------------------------------------

describe('isPathWithinDir', () => {
  const base = '/data/agents/agent'

  it('accepts the base directory itself', () => {
    expect(isPathWithinDir(base, base)).toBe(true)
    expect(isPathWithinDir(base, base + '/')).toBe(true)
  })

  it('accepts files and nested dirs inside the base', () => {
    expect(isPathWithinDir(base, path.resolve(base, 'file.txt'))).toBe(true)
    expect(isPathWithinDir(base, path.resolve(base, 'a/b/c.txt'))).toBe(true)
    expect(isPathWithinDir(base, path.resolve(base, './nested/x'))).toBe(true)
  })

  it('rejects the SIBLING-PREFIX escape (the SUP-200 vector)', () => {
    // `/data/agents/agent-victim` shares the `/data/agents/agent` prefix, so a
    // naive startsWith() check would wrongly accept it.
    expect('/data/agents/agent-victim/secret'.startsWith(base)).toBe(true) // demonstrates the trap
    expect(isPathWithinDir(base, '/data/agents/agent-victim/secret')).toBe(false)
    expect(isPathWithinDir(base, path.resolve(base, '../agent-victim/secret'))).toBe(false)
  })

  it('rejects parent-directory traversal', () => {
    expect(isPathWithinDir(base, path.resolve(base, '..'))).toBe(false)
    expect(isPathWithinDir(base, path.resolve(base, '../..'))).toBe(false)
    expect(isPathWithinDir(base, path.resolve(base, '../../etc/passwd'))).toBe(false)
    expect(isPathWithinDir(base, '/data/agents')).toBe(false) // the parent
  })

  it('rejects already-decoded ../ traversal coming from path.resolve', () => {
    // Mirrors the agent file-download route: decodeURIComponent('%2e%2e%2f') === '../'
    const decoded = '../'.repeat(3) + 'etc/passwd'
    expect(isPathWithinDir(base, path.resolve(base, decoded))).toBe(false)
  })

  it('rejects absolute paths outside the base', () => {
    expect(isPathWithinDir(base, '/etc/passwd')).toBe(false)
    expect(isPathWithinDir(base, '/tmp/file.txt')).toBe(false)
    expect(isPathWithinDir('/workspace', '/root/.ssh/id_rsa')).toBe(false)
  })

  it('treats relative candidates against the base via resolve', () => {
    // path.resolve(base, 'uploads/x') stays inside; '../x' escapes.
    expect(isPathWithinDir(base, path.resolve(base, 'uploads/x'))).toBe(true)
    expect(isPathWithinDir(base, path.resolve(base, '../x'))).toBe(false)
  })

  it('normalizes . and redundant separators inside the base', () => {
    expect(isPathWithinDir(base, base + '/./a/./b')).toBe(true)
    expect(isPathWithinDir(base, base + '/a/../b')).toBe(true) // stays inside
    expect(isPathWithinDir(base, base + '/a/../../agent-victim')).toBe(false)
  })
})

describe('assertPathWithinDir', () => {
  const base = '/workspace'

  it('returns the resolved path for contained candidates', () => {
    expect(assertPathWithinDir(base, path.resolve(base, 'uploads/file.txt'))).toBe(
      path.resolve(base, 'uploads/file.txt'),
    )
    expect(assertPathWithinDir(base, base)).toBe(path.resolve(base))
  })

  it('throws on escape with the default message', () => {
    expect(() => assertPathWithinDir(base, '/etc/passwd')).toThrow('Invalid path')
    expect(() => assertPathWithinDir(base, path.resolve(base, '../etc/passwd'))).toThrow('Invalid path')
  })

  it('throws on the sibling-prefix escape', () => {
    expect(() => assertPathWithinDir(base, '/workspace-evil/x')).toThrow()
  })

  it('supports a custom error message', () => {
    expect(() => assertPathWithinDir(base, '/etc/passwd', 'nope')).toThrow('nope')
  })
})

describe('sanitizeUploadFilename', () => {
  const traversalInputs = [
    '../../../oauth-token.txt',
    '../../../../etc/cron.d/x',
    '..\\..\\win.txt',
    '/etc/passwd',
    'foo/bar.txt',
    '.',
    '',
  ]

  it('never yields a name that escapes the uploads directory', () => {
    const uploadsDir = path.resolve('/workspace', 'uploads')
    for (const input of traversalInputs) {
      const safe = sanitizeUploadFilename(input)
      const uploadName = `${Date.now()}-${safe}`
      const full = path.resolve(uploadsDir, uploadName)
      const rel = path.relative(uploadsDir, full)
      expect(rel.startsWith('..'), `input ${JSON.stringify(input)} -> ${safe}`).toBe(false)
      expect(path.isAbsolute(rel), `input ${JSON.stringify(input)} -> ${safe}`).toBe(false)
      // No path separators survive.
      expect(safe.includes('/')).toBe(false)
      expect(safe.includes('\\')).toBe(false)
      expect(safe).not.toBe('')
    }
  })

  it('reduces traversal/path inputs to a safe basename', () => {
    expect(sanitizeUploadFilename('../../../oauth-token.txt')).toBe('oauth-token.txt')
    expect(sanitizeUploadFilename('foo/bar.txt')).toBe('bar.txt')
    expect(sanitizeUploadFilename('/etc/passwd')).toBe('passwd')
    expect(sanitizeUploadFilename('..\\..\\win.txt')).toBe('win.txt')
  })

  it('falls back to a default name when nothing usable remains', () => {
    expect(sanitizeUploadFilename('.')).toBe('file')
    expect(sanitizeUploadFilename('')).toBe('file')
    expect(sanitizeUploadFilename('..')).toBe('file')
    expect(sanitizeUploadFilename('\0')).toBe('file')
  })

  it('preserves a normal filename unchanged', () => {
    expect(sanitizeUploadFilename('report.pdf')).toBe('report.pdf')
    expect(sanitizeUploadFilename('My_File-2.png')).toBe('My_File-2.png')
  })
})

// ---------------------------------------------------------------------------
// Symlink-aware containment. isPathWithinDir compares strings; this one follows
// links, because the base directory here is writable by an untrusted party.
// ---------------------------------------------------------------------------

describe('isRealPathWithinDir', () => {
  let tmp: string
  let base: string
  let outside: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'realpath-')))
    base = path.join(tmp, 'agent', 'sessions')
    outside = path.join(tmp, 'other-agent', 'sessions')
    fs.mkdirSync(base, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('accepts a real file inside the base', () => {
    const f = path.join(base, 'a.jsonl')
    fs.writeFileSync(f, '{}')
    expect(isRealPathWithinDir(base, f)).toBe(true)
  })

  it('accepts a not-yet-created leaf under the base (its name was already validated)', () => {
    expect(isRealPathWithinDir(base, path.join(base, 'not-written-yet.jsonl'))).toBe(true)
  })

  it('rejects a symlink whose target escapes the base', () => {
    const victim = path.join(outside, 'victim.jsonl')
    fs.writeFileSync(victim, 'secret')
    const link = path.join(base, 'victim.jsonl')
    fs.symlinkSync(victim, link)
    expect(isRealPathWithinDir(base, link)).toBe(false)
  })

  it('rejects a leaf reached through a symlinked directory that escapes the base', () => {
    const link = path.join(base, 'linkdir')
    fs.symlinkSync(outside, link)
    expect(isRealPathWithinDir(base, path.join(link, 'anything.jsonl'))).toBe(false)
  })

  it('accepts a symlink that stays inside the base', () => {
    const real = path.join(base, 'real.jsonl')
    fs.writeFileSync(real, '{}')
    const link = path.join(base, 'alias.jsonl')
    fs.symlinkSync(real, link)
    expect(isRealPathWithinDir(base, link)).toBe(true)
  })
})
