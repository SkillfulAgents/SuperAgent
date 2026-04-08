import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readChromeDebugPort } from './chrome-debug-port'

describe('readChromeDebugPort', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function writeDevToolsActivePort(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-debug-port-test-'))
    fs.writeFileSync(path.join(tmpDir, 'DevToolsActivePort'), content)
    return tmpDir
  }

  it('reads port from a standard DevToolsActivePort file', () => {
    const dir = writeDevToolsActivePort('9222\n/devtools/browser/abc-123\n')
    expect(readChromeDebugPort(dir)).toBe(9222)
  })

  it('reads a dynamic port (port 0 resolved to random port)', () => {
    const dir = writeDevToolsActivePort('41567\n/devtools/browser/def-456\n')
    expect(readChromeDebugPort(dir)).toBe(41567)
  })

  it('reads port when file has only the port line', () => {
    const dir = writeDevToolsActivePort('9333')
    expect(readChromeDebugPort(dir)).toBe(9333)
  })

  it('returns null when DevToolsActivePort file does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-debug-port-test-'))
    expect(readChromeDebugPort(tmpDir)).toBeNull()
  })

  it('returns null when profile directory does not exist', () => {
    expect(readChromeDebugPort('/nonexistent/path')).toBeNull()
  })

  it('returns null when file content is not a number', () => {
    const dir = writeDevToolsActivePort('not-a-port\n')
    expect(readChromeDebugPort(dir)).toBeNull()
  })

  it('returns null when file is empty', () => {
    const dir = writeDevToolsActivePort('')
    expect(readChromeDebugPort(dir)).toBeNull()
  })
})
