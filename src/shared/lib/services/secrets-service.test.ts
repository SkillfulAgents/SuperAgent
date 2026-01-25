import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  parseEnvFile,
  serializeEnvFile,
  keyToEnvVar,
  listSecrets,
  getSecret,
  setSecret,
  deleteSecret,
  hasSecrets,
  getSecretEnvVars,
} from './secrets-service'
import {
  SAMPLE_ENV_FILE,
  SAMPLE_ENV_FILE_WITH_SPECIAL_CHARS,
} from './__fixtures__/test-data'

// ============================================================================
// Pure Function Tests (no mocking needed)
// ============================================================================

describe('parseEnvFile', () => {
  it('parses basic KEY=value pairs', () => {
    const content = `FOO=bar
BAZ=qux`
    const result = parseEnvFile(content)

    expect(result.get('FOO')).toEqual({ value: 'bar', comment: undefined })
    expect(result.get('BAZ')).toEqual({ value: 'qux', comment: undefined })
  })

  it('parses values with inline comments', () => {
    const content = `API_KEY=secret123  # My API Key`
    const result = parseEnvFile(content)

    expect(result.get('API_KEY')).toEqual({
      value: 'secret123',
      comment: 'My API Key',
    })
  })

  it('skips comment-only lines', () => {
    const content = `# This is a comment
FOO=bar
# Another comment`
    const result = parseEnvFile(content)

    expect(result.size).toBe(1)
    expect(result.get('FOO')?.value).toBe('bar')
  })

  it('skips empty lines', () => {
    const content = `FOO=bar

BAZ=qux

`
    const result = parseEnvFile(content)

    expect(result.size).toBe(2)
  })

  it('handles quoted values', () => {
    const content = `DOUBLE="hello world"
SINGLE='single quoted'`
    const result = parseEnvFile(content)

    expect(result.get('DOUBLE')?.value).toBe('hello world')
    expect(result.get('SINGLE')?.value).toBe('single quoted')
  })

  it('handles values with equals signs', () => {
    const content = `URL=https://example.com?foo=bar`
    const result = parseEnvFile(content)

    expect(result.get('URL')?.value).toBe('https://example.com?foo=bar')
  })

  it('parses real sample env file', () => {
    const result = parseEnvFile(SAMPLE_ENV_FILE)

    expect(result.get('GITHUB_TOKEN')).toEqual({
      value: 'ghp_xxxxxxxxxxxxxxxxxxxx',
      comment: 'GitHub Token',
    })
    expect(result.get('OPENAI_API_KEY')).toEqual({
      value: 'sk-xxxxxxxxxxxxxxxx',
      comment: 'OpenAI API Key',
    })
    expect(result.get('SIMPLE_KEY')?.value).toBe('simplevalue')
    expect(result.get('QUOTED_VALUE')?.value).toBe('value with spaces')
  })

  it('handles special characters in quoted values', () => {
    const result = parseEnvFile(SAMPLE_ENV_FILE_WITH_SPECIAL_CHARS)

    expect(result.get('API_KEY')?.value).toBe('key=with=equals')
    expect(result.get('URL')?.value).toBe('https://example.com?foo=bar#anchor')
  })

  it('handles Windows line endings', () => {
    const content = 'FOO=bar\r\nBAZ=qux\r\n'
    const result = parseEnvFile(content)

    expect(result.size).toBe(2)
    expect(result.get('FOO')?.value).toBe('bar')
    expect(result.get('BAZ')?.value).toBe('qux')
  })

  it('handles lines without equals sign', () => {
    const content = `FOO=bar
INVALID LINE
BAZ=qux`
    const result = parseEnvFile(content)

    expect(result.size).toBe(2)
  })
})

describe('serializeEnvFile', () => {
  it('serializes secrets to env format', () => {
    const secrets = [
      { key: 'API Key', envVar: 'API_KEY', value: 'secret123' },
      { key: 'TOKEN', envVar: 'TOKEN', value: 'token456' },
    ]

    const result = serializeEnvFile(secrets)

    expect(result).toContain('API_KEY=secret123  # API Key')
    expect(result).toContain('TOKEN=token456')
    expect(result).not.toContain('TOKEN=token456  # TOKEN') // No comment when key === envVar
  })

  it('includes header comments', () => {
    const secrets = [{ key: 'KEY', envVar: 'KEY', value: 'value' }]
    const result = serializeEnvFile(secrets)

    expect(result).toContain('# Superagent Secrets')
    expect(result).toContain('# Format: ENV_VAR=value  # Display Name')
  })

  it('quotes values with spaces', () => {
    const secrets = [
      { key: 'Key', envVar: 'KEY', value: 'value with spaces' },
    ]
    const result = serializeEnvFile(secrets)

    expect(result).toContain('KEY="value with spaces"')
  })

  it('quotes values with special characters', () => {
    const secrets = [
      { key: 'URL', envVar: 'URL', value: 'https://example.com#anchor' },
      { key: 'Quoted', envVar: 'QUOTED', value: 'has "quotes"' },
    ]
    const result = serializeEnvFile(secrets)

    expect(result).toContain('URL="https://example.com#anchor"')
    expect(result).toContain('QUOTED="has \\"quotes\\""')
  })

  it('escapes newlines in values', () => {
    const secrets = [
      { key: 'Multi', envVar: 'MULTI', value: 'line1\nline2' },
    ]
    const result = serializeEnvFile(secrets)

    expect(result).toContain('MULTI="line1\\nline2"')
  })

  it('ends with newline', () => {
    const secrets = [{ key: 'KEY', envVar: 'KEY', value: 'value' }]
    const result = serializeEnvFile(secrets)

    expect(result.endsWith('\n')).toBe(true)
  })

  it('handles empty secrets array', () => {
    const result = serializeEnvFile([])

    expect(result).toContain('# Superagent Secrets')
    expect(result.split('\n').filter((l) => l && !l.startsWith('#')).length).toBe(0)
  })
})

describe('keyToEnvVar', () => {
  it('converts display name to env var format', () => {
    expect(keyToEnvVar('My API Key')).toBe('MY_API_KEY')
  })

  it('handles already uppercase', () => {
    expect(keyToEnvVar('ALREADY_UPPER')).toBe('ALREADY_UPPER')
  })

  it('replaces special characters with underscores', () => {
    expect(keyToEnvVar('key-with-dashes')).toBe('KEY_WITH_DASHES')
    expect(keyToEnvVar('key.with.dots')).toBe('KEY_WITH_DOTS')
    expect(keyToEnvVar('key@#$special')).toBe('KEY_SPECIAL')
  })

  it('removes leading/trailing underscores', () => {
    expect(keyToEnvVar('  spaces  ')).toBe('SPACES')
    expect(keyToEnvVar('---dashes---')).toBe('DASHES')
  })

  it('handles numbers', () => {
    expect(keyToEnvVar('Key123')).toBe('KEY123')
    expect(keyToEnvVar('123Key')).toBe('123KEY')
  })
})

// ============================================================================
// Integration Tests (with temp directories)
// ============================================================================

describe('secrets service integration', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    // Create a unique temp directory
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'secrets-service-test-')
    )

    // Store original env and set test data dir
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir

    // Create agent workspace structure
    const workspaceDir = path.join(testDir, 'agents', 'test-agent', 'workspace')
    await fs.promises.mkdir(workspaceDir, { recursive: true })
  })

  afterEach(async () => {
    // Restore env
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }

    // Clean up temp directory
    await fs.promises.rm(testDir, { recursive: true, force: true })

    // Reset module cache to pick up env changes
    vi.resetModules()
  })

  describe('listSecrets', () => {
    it('returns empty array when no .env file exists', async () => {
      const secrets = await listSecrets('test-agent')
      expect(secrets).toEqual([])
    })

    it('returns secrets from existing .env file', async () => {
      const envPath = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        '.env'
      )
      await fs.promises.writeFile(envPath, SAMPLE_ENV_FILE)

      const secrets = await listSecrets('test-agent')

      expect(secrets.length).toBe(4)
      expect(secrets.find((s) => s.envVar === 'GITHUB_TOKEN')).toEqual({
        envVar: 'GITHUB_TOKEN',
        value: 'ghp_xxxxxxxxxxxxxxxxxxxx',
        key: 'GitHub Token',
      })
    })
  })

  describe('getSecret', () => {
    it('returns null when secret does not exist', async () => {
      const secret = await getSecret('test-agent', 'NONEXISTENT')
      expect(secret).toBeNull()
    })

    it('returns secret when it exists', async () => {
      const envPath = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        '.env'
      )
      await fs.promises.writeFile(envPath, 'API_KEY=secret123  # My Key')

      const secret = await getSecret('test-agent', 'API_KEY')

      expect(secret).toEqual({
        envVar: 'API_KEY',
        value: 'secret123',
        key: 'My Key',
      })
    })
  })

  describe('setSecret', () => {
    it('creates .env file and adds secret', async () => {
      await setSecret('test-agent', {
        key: 'New Key',
        envVar: 'NEW_KEY',
        value: 'new_value',
      })

      const secrets = await listSecrets('test-agent')
      expect(secrets.length).toBe(1)
      expect(secrets[0]).toEqual({
        key: 'New Key',
        envVar: 'NEW_KEY',
        value: 'new_value',
      })
    })

    it('updates existing secret', async () => {
      await setSecret('test-agent', {
        key: 'Key',
        envVar: 'KEY',
        value: 'original',
      })

      await setSecret('test-agent', {
        key: 'Key',
        envVar: 'KEY',
        value: 'updated',
      })

      const secrets = await listSecrets('test-agent')
      expect(secrets.length).toBe(1)
      expect(secrets[0].value).toBe('updated')
    })

    it('adds new secret to existing file', async () => {
      await setSecret('test-agent', {
        key: 'First',
        envVar: 'FIRST',
        value: 'first_value',
      })

      await setSecret('test-agent', {
        key: 'Second',
        envVar: 'SECOND',
        value: 'second_value',
      })

      const secrets = await listSecrets('test-agent')
      expect(secrets.length).toBe(2)
    })

    it('creates .env with restrictive permissions', async () => {
      await setSecret('test-agent', {
        key: 'Secret',
        envVar: 'SECRET',
        value: 'sensitive',
      })

      const envPath = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        '.env'
      )
      const stats = await fs.promises.stat(envPath)

      // Check owner read/write only (0o600)
      expect(stats.mode & 0o777).toBe(0o600)
    })
  })

  describe('deleteSecret', () => {
    it('returns false when secret does not exist', async () => {
      const result = await deleteSecret('test-agent', 'NONEXISTENT')
      expect(result).toBe(false)
    })

    it('removes secret and returns true', async () => {
      await setSecret('test-agent', {
        key: 'Key',
        envVar: 'KEY',
        value: 'value',
      })

      const result = await deleteSecret('test-agent', 'KEY')

      expect(result).toBe(true)
      const secrets = await listSecrets('test-agent')
      expect(secrets.length).toBe(0)
    })

    it('preserves other secrets when deleting one', async () => {
      await setSecret('test-agent', { key: 'A', envVar: 'A', value: 'a' })
      await setSecret('test-agent', { key: 'B', envVar: 'B', value: 'b' })
      await setSecret('test-agent', { key: 'C', envVar: 'C', value: 'c' })

      await deleteSecret('test-agent', 'B')

      const secrets = await listSecrets('test-agent')
      expect(secrets.length).toBe(2)
      expect(secrets.map((s) => s.envVar).sort()).toEqual(['A', 'C'])
    })
  })

  describe('hasSecrets', () => {
    it('returns false when no .env file', async () => {
      const result = await hasSecrets('test-agent')
      expect(result).toBe(false)
    })

    it('returns false when .env is empty', async () => {
      const envPath = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        '.env'
      )
      await fs.promises.writeFile(envPath, '# Just comments\n')

      const result = await hasSecrets('test-agent')
      expect(result).toBe(false)
    })

    it('returns true when secrets exist', async () => {
      await setSecret('test-agent', {
        key: 'Key',
        envVar: 'KEY',
        value: 'value',
      })

      const result = await hasSecrets('test-agent')
      expect(result).toBe(true)
    })
  })

  describe('getSecretEnvVars', () => {
    it('returns empty array when no secrets', async () => {
      const envVars = await getSecretEnvVars('test-agent')
      expect(envVars).toEqual([])
    })

    it('returns list of env var names', async () => {
      await setSecret('test-agent', { key: 'A', envVar: 'VAR_A', value: 'a' })
      await setSecret('test-agent', { key: 'B', envVar: 'VAR_B', value: 'b' })

      const envVars = await getSecretEnvVars('test-agent')
      expect(envVars.sort()).toEqual(['VAR_A', 'VAR_B'])
    })
  })
})
