import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { writeEnvFile } from './base-container-client'

describe('writeEnvFile', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    // Clean up any env files created during tests
    for (const cleanup of cleanups) {
      cleanup()
    }
    cleanups.length = 0
  })

  it('writes basic KEY=VALUE pairs to a file', () => {
    const { flag, cleanup } = writeEnvFile(
      { FOO: 'bar', BAZ: 'qux' },
      'test-agent'
    )
    cleanups.push(cleanup)

    // Extract file path from the flag
    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('FOO=bar\nBAZ=qux')
  })

  it('returns a valid --env-file flag with quoted path', () => {
    const { flag, cleanup } = writeEnvFile({ KEY: 'val' }, 'test-agent')
    cleanups.push(cleanup)

    expect(flag).toMatch(/^--env-file ".+"$/)
  })

  it('creates the file in the OS temp directory', () => {
    const { flag, cleanup } = writeEnvFile({ KEY: 'val' }, 'test-agent')
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    expect(filePath.startsWith(os.tmpdir())).toBe(true)
  })

  it('includes the agent ID in the filename', () => {
    const { flag, cleanup } = writeEnvFile({ KEY: 'val' }, 'my-cool-agent')
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    expect(path.basename(filePath)).toContain('my-cool-agent')
  })

  it('filters out undefined values', () => {
    const { flag, cleanup } = writeEnvFile(
      { KEEP: 'yes', DROP: undefined, ALSO_KEEP: 'yep' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('KEEP=yes\nALSO_KEEP=yep')
    expect(content).not.toContain('DROP')
  })

  it('handles empty env vars (all undefined)', () => {
    const { flag, cleanup } = writeEnvFile(
      { A: undefined, B: undefined },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('')
  })

  it('handles empty object', () => {
    const { flag, cleanup } = writeEnvFile({}, 'test-agent')
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('')
  })

  it('strips \\n from values', () => {
    const { flag, cleanup } = writeEnvFile(
      { KEY: 'line1\nline2\nline3' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('KEY=line1line2line3')
    // Should be exactly one line (no embedded newlines)
    expect(content.split('\n')).toHaveLength(1)
  })

  it('strips \\r\\n from values', () => {
    const { flag, cleanup } = writeEnvFile(
      { KEY: 'line1\r\nline2' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('KEY=line1line2')
  })

  it('strips standalone \\r from values', () => {
    const { flag, cleanup } = writeEnvFile(
      { KEY: 'before\rafter' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('KEY=beforeafter')
  })

  it('preserves values with special shell characters (no quoting needed)', () => {
    const specialValue = `it's got "quotes" & pipes | and $dollars (parens) <angle> {braces}`
    const { flag, cleanup } = writeEnvFile(
      { KEY: specialValue },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    // Docker env-file reads literally — no shell interpretation
    expect(content).toBe(`KEY=${specialValue}`)
  })

  it('preserves values with percent signs (Windows cmd.exe metachar)', () => {
    const { flag, cleanup } = writeEnvFile(
      { KEY: '%PATH% and %USERNAME%' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('KEY=%PATH% and %USERNAME%')
  })

  it('handles values with equals signs', () => {
    const { flag, cleanup } = writeEnvFile(
      { KEY: 'base64==encoded==' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    // Docker env-file splits on first = only, so extra = in value is fine
    expect(content).toBe('KEY=base64==encoded==')
  })

  it('handles a realistic API key value', () => {
    const apiKey = 'test-key-that-is-long-enough-to-be-realistic-' + 'x'.repeat(100)
    const { flag, cleanup } = writeEnvFile(
      { ANTHROPIC_API_KEY: apiKey },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe(`ANTHROPIC_API_KEY=${apiKey}`)
  })

  it('handles a realistic JSON env var (CONNECTED_ACCOUNTS)', () => {
    const jsonValue = JSON.stringify({ github: { id: 'abc', name: 'GitHub' }, slack: { id: 'def', name: 'Slack' } })
    const { flag, cleanup } = writeEnvFile(
      { CONNECTED_ACCOUNTS: jsonValue },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe(`CONNECTED_ACCOUNTS=${jsonValue}`)
    // Verify the JSON is intact and parseable
    const line = content.split('=').slice(1).join('=')
    expect(JSON.parse(line)).toEqual(JSON.parse(jsonValue))
  })

  it('handles many env vars without hitting length limits', () => {
    const envVars: Record<string, string> = {}
    // 100 env vars with long values — would exceed cmd.exe 8191 char limit inline
    for (let i = 0; i < 100; i++) {
      envVars[`VAR_${i}`] = 'x'.repeat(200)
    }

    const { flag, cleanup } = writeEnvFile(envVars, 'test-agent')
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    expect(lines).toHaveLength(100)
    // The flag itself is short regardless of content size
    expect(flag.length).toBeLessThan(300)
  })

  it('handles empty string values', () => {
    const { flag, cleanup } = writeEnvFile(
      { EMPTY: '', NON_EMPTY: 'hello' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('EMPTY=\nNON_EMPTY=hello')
  })

  it('handles values with unicode characters', () => {
    const { flag, cleanup } = writeEnvFile(
      { KEY: 'héllo wörld 你好 🚀' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('KEY=héllo wörld 你好 🚀')
  })

  it('cleanup deletes the file', () => {
    const { flag, cleanup } = writeEnvFile({ KEY: 'val' }, 'test-agent')

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    expect(fs.existsSync(filePath)).toBe(true)

    cleanup()
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('cleanup does not throw if file already deleted', () => {
    const { flag, cleanup } = writeEnvFile({ KEY: 'val' }, 'test-agent')

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    fs.unlinkSync(filePath) // Delete it manually first

    // Should not throw
    expect(() => cleanup()).not.toThrow()
  })

  it('cleanup does not throw if called multiple times', () => {
    const { flag, cleanup } = writeEnvFile({ KEY: 'val' }, 'test-agent')
    cleanups.push(cleanup)

    // Call cleanup twice — second call should be a no-op
    cleanup()
    expect(() => cleanup()).not.toThrow()
  })

  it('generates unique file paths for concurrent calls', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      writeEnvFile({ KEY: `val${i}` }, 'test-agent')
    )
    results.forEach(r => cleanups.push(r.cleanup))

    const paths = results.map(r => r.flag.match(/--env-file "(.+)"/)![1])
    const uniquePaths = new Set(paths)

    expect(uniquePaths.size).toBe(5)
  })

  it('preserves order of env vars', () => {
    const { flag, cleanup } = writeEnvFile(
      { FIRST: '1', SECOND: '2', THIRD: '3' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n')

    expect(lines[0]).toBe('FIRST=1')
    expect(lines[1]).toBe('SECOND=2')
    expect(lines[2]).toBe('THIRD=3')
  })

  it('handles values with backslashes (Windows paths)', () => {
    const { flag, cleanup } = writeEnvFile(
      { PATH_VAR: 'C:\\Users\\test\\Documents' },
      'test-agent'
    )
    cleanups.push(cleanup)

    const filePath = flag.match(/--env-file "(.+)"/)![1]
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).toBe('PATH_VAR=C:\\Users\\test\\Documents')
  })
})
