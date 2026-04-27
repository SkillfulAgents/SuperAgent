import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const mockGetContainerEnvVars = vi.fn()
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: mockGetContainerEnvVars }),
}))

import {
  writeEnvFile,
  parseMemoryValue,
  shellQuote,
  isConnectionError,
  getEnhancedPath,
  getSessionCustomEnvVars,
} from './base-container-client'

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
    const { cleanup } = writeEnvFile({ KEY: 'val' }, 'test-agent')
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

// ============================================================================
// parseMemoryValue
// ============================================================================

describe('parseMemoryValue', () => {
  it('parses bytes (B)', () => {
    expect(parseMemoryValue('100B')).toBe(100)
  })

  it('parses KiB (binary kilobytes)', () => {
    expect(parseMemoryValue('1KiB')).toBe(1024)
  })

  it('parses KB (decimal kilobytes)', () => {
    expect(parseMemoryValue('1KB')).toBe(1000)
  })

  it('parses MiB (binary megabytes)', () => {
    expect(parseMemoryValue('1MiB')).toBe(1024 * 1024)
  })

  it('parses MB (decimal megabytes)', () => {
    expect(parseMemoryValue('1MB')).toBe(1e6)
  })

  it('parses GiB (binary gigabytes)', () => {
    expect(parseMemoryValue('1GiB')).toBe(1024 ** 3)
  })

  it('parses GB (decimal gigabytes)', () => {
    expect(parseMemoryValue('1GB')).toBe(1e9)
  })

  it('parses TiB (binary terabytes)', () => {
    expect(parseMemoryValue('1TiB')).toBe(1024 ** 4)
  })

  it('parses TB (decimal terabytes)', () => {
    expect(parseMemoryValue('1TB')).toBe(1e12)
  })

  it('parses decimal values', () => {
    // 231.2 MiB = 231.2 * 1048576 = 242,357,616.2 -> rounded to 242357616
    expect(parseMemoryValue('231.2MiB')).toBe(Math.round(231.2 * 1024 ** 2))
  })

  it('parses 1.5GiB correctly', () => {
    expect(parseMemoryValue('1.5GiB')).toBe(Math.round(1.5 * 1024 ** 3))
  })

  it('parses value with no unit as bytes', () => {
    expect(parseMemoryValue('512')).toBe(512)
  })

  it('parses kB (lowercase k)', () => {
    expect(parseMemoryValue('100kB')).toBe(100 * 1000)
  })

  it('is case-insensitive for unit', () => {
    expect(parseMemoryValue('1mib')).toBe(1024 ** 2)
    expect(parseMemoryValue('1MIB')).toBe(1024 ** 2)
    expect(parseMemoryValue('1Mib')).toBe(1024 ** 2)
  })

  it('handles space between number and unit', () => {
    expect(parseMemoryValue('512 MiB')).toBe(512 * 1024 ** 2)
  })

  it('returns 0 for empty string', () => {
    expect(parseMemoryValue('')).toBe(0)
  })

  it('returns 0 for invalid strings', () => {
    expect(parseMemoryValue('not-a-number')).toBe(0)
    expect(parseMemoryValue('abc MiB')).toBe(0)
  })

  it('returns 0 for negative values (no match)', () => {
    // The regex requires digits at the start, so negative won't match
    expect(parseMemoryValue('-100MiB')).toBe(0)
  })

  it('handles realistic Docker stats format "231.2MiB / 512MiB" parts', () => {
    // This is how it's used: split on "/" and parse each part
    const parts = '231.2MiB / 512MiB'.split('/')
    const usage = parseMemoryValue(parts[0].trim())
    const limit = parseMemoryValue(parts[1].trim())
    expect(usage).toBe(Math.round(231.2 * 1024 ** 2))
    expect(limit).toBe(512 * 1024 ** 2)
  })
})

// ============================================================================
// shellQuote
// ============================================================================

describe('shellQuote', () => {
  // Note: shellQuote checks the module-level `isWindows` constant which is
  // set at module load time from process.platform. On macOS/Linux this will
  // always be the single-quote path; on Windows, the double-quote path.

  it('wraps a simple string', () => {
    const quoted = shellQuote('hello')
    // On Unix: 'hello', on Windows: "hello"
    expect(quoted === "'hello'" || quoted === '"hello"').toBe(true)
  })

  it('wraps strings with spaces', () => {
    const quoted = shellQuote('hello world')
    expect(quoted === "'hello world'" || quoted === '"hello world"').toBe(true)
  })

  it('wraps strings with special characters', () => {
    const quoted = shellQuote('{{json .}}')
    expect(quoted === "'{{json .}}'" || quoted === '"{{json .}}"').toBe(true)
  })

  it('wraps empty string', () => {
    const quoted = shellQuote('')
    expect(quoted === "''" || quoted === '""').toBe(true)
  })

  if (process.platform !== 'win32') {
    it('uses single quotes on Unix', () => {
      expect(shellQuote('test')).toBe("'test'")
    })

    it('does not escape internal single quotes (raw pass-through)', () => {
      // shellQuote is a simple wrapper; it doesn't escape internal quotes
      expect(shellQuote("it's")).toBe("'it's'")
    })
  }

  if (process.platform === 'win32') {
    it('uses double quotes on Windows', () => {
      expect(shellQuote('test')).toBe('"test"')
    })
  }
})

// ============================================================================
// isConnectionError
// ============================================================================

describe('isConnectionError', () => {
  it('returns true for ECONNREFUSED', () => {
    expect(isConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:4000'))).toBe(true)
  })

  it('returns true for ECONNRESET', () => {
    expect(isConnectionError(new Error('read ECONNRESET'))).toBe(true)
  })

  it('returns true for ETIMEDOUT', () => {
    expect(isConnectionError(new Error('connect ETIMEDOUT 10.0.0.1:3000'))).toBe(true)
  })

  it('returns true for "fetch failed"', () => {
    expect(isConnectionError(new Error('fetch failed'))).toBe(true)
  })

  it('returns true when error message contains connection keyword among other text', () => {
    expect(isConnectionError(new Error('Something went wrong: ECONNREFUSED at port 4000'))).toBe(true)
  })

  it('returns false for generic errors', () => {
    expect(isConnectionError(new Error('Something went wrong'))).toBe(false)
  })

  it('returns false for HTTP-level errors', () => {
    expect(isConnectionError(new Error('HTTP 500 Internal Server Error'))).toBe(false)
  })

  it('returns false for empty error message', () => {
    expect(isConnectionError(new Error(''))).toBe(false)
  })

  it('returns false for auth errors', () => {
    expect(isConnectionError(new Error('401 Unauthorized'))).toBe(false)
  })
})

// ============================================================================
// getEnhancedPath
// ============================================================================

describe('getEnhancedPath', () => {
  const originalPath = process.env.PATH

  afterEach(() => {
    // Restore original PATH
    process.env.PATH = originalPath
  })

  it('includes the current PATH', () => {
    process.env.PATH = '/usr/bin:/usr/local/bin'
    const enhanced = getEnhancedPath()
    expect(enhanced).toContain('/usr/bin')
    expect(enhanced).toContain('/usr/local/bin')
  })

  it('adds platform-specific paths that are not already present', () => {
    // Set PATH to something that is missing common paths
    process.env.PATH = '/some/custom/path'
    const enhanced = getEnhancedPath()

    // It should contain the custom path
    expect(enhanced).toContain('/some/custom/path')

    // On macOS, it should add common Docker/Homebrew paths
    if (process.platform === 'darwin') {
      expect(enhanced).toContain('/opt/homebrew/bin')
      expect(enhanced).toContain('/Applications/Docker.app/Contents/Resources/bin')
    }
    // On linux, should add common paths
    if (process.platform === 'linux') {
      expect(enhanced).toContain('/usr/local/bin')
    }
  })

  it('does not duplicate paths already in PATH', () => {
    if (process.platform === 'darwin') {
      process.env.PATH = '/opt/homebrew/bin:/usr/bin'
      const enhanced = getEnhancedPath()

      // /opt/homebrew/bin should appear only once
      const occurrences = enhanced.split(path.delimiter).filter(p => p === '/opt/homebrew/bin')
      expect(occurrences.length).toBe(1)
    }
  })

  it('handles empty PATH', () => {
    process.env.PATH = ''
    const enhanced = getEnhancedPath()
    // Should still return something (the common binary paths)
    expect(enhanced.length).toBeGreaterThan(0)
  })

  it('handles undefined PATH', () => {
    delete process.env.PATH
    const enhanced = getEnhancedPath()
    expect(typeof enhanced).toBe('string')
  })

  it('uses path.delimiter to join paths', () => {
    process.env.PATH = '/some/path'
    const enhanced = getEnhancedPath()
    // Every separator should be the platform delimiter
    const parts = enhanced.split(path.delimiter)
    expect(parts.length).toBeGreaterThan(1)
  })
})

describe('getSessionCustomEnvVars', () => {
  it('returns undefined when no customEnvVars are supplied', () => {
    mockGetContainerEnvVars.mockReturnValue({ ANTHROPIC_API_KEY: 'sk' })
    expect(getSessionCustomEnvVars('agent-1', undefined)).toBeUndefined()
  })

  it('passes customEnvVars through untouched when provider has no managed keys', () => {
    mockGetContainerEnvVars.mockReturnValue({})
    expect(getSessionCustomEnvVars('agent-1', { MY_VAR: 'x', OTHER: 'y' })).toEqual({
      MY_VAR: 'x',
      OTHER: 'y',
    })
  })

  it('strips provider-managed keys so agents cannot bypass attribution', () => {
    mockGetContainerEnvVars.mockReturnValue({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      ANTHROPIC_AUTH_TOKEN: 'platform-token',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Platform-Member-Id: sub_real_owner',
    })

    const filtered = getSessionCustomEnvVars('agent-1', {
      MY_VAR: 'x',
      ANTHROPIC_AUTH_TOKEN: 'hijacked-token',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Platform-Member-Id: sub_fake_owner',
    })

    expect(filtered).toEqual({ MY_VAR: 'x' })
    expect(filtered).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(filtered).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
  })
})
