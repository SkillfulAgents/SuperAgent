import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  RESERVED_ENV_VAR_KEYS,
  isReservedEnvVar,
  mergeCustomEnvVars,
  findReservedEnvVarKeys,
  customEnvVarsSchema,
} from './reserved-env-vars'

describe('reserved-env-vars', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reserves the full set of runtime keys', () => {
    for (const key of [
      'PROXY_BASE_URL',
      'PROXY_TOKEN',
      'SUPERAGENT_HOST_API_URL',
      'SUPERAGENT_AGENT_SLUG',
      'CONNECTED_ACCOUNTS',
      'REMOTE_MCPS',
      'AGENT_BROWSER_USE_HOST',
      'HOST_APP_URL',
      'AGENT_ID',
      'TZ',
      'HOST_PLATFORM',
      'COMPOSIO_PLATFORM_MODE',
      'CLAUDE_CODE_ATTRIBUTION_HEADER',
      'SHARE_DASHBOARD_ENABLED',
    ]) {
      expect(RESERVED_ENV_VAR_KEYS.has(key)).toBe(true)
      expect(isReservedEnvVar(key)).toBe(true)
    }
    expect(isReservedEnvVar('MY_CUSTOM')).toBe(false)
  })

  describe('mergeCustomEnvVars', () => {
    it('skips reserved keys and warns, but passes non-reserved through', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const target: Record<string, string> = { PROXY_TOKEN: 'real', TZ: 'America/New_York' }

      const result = mergeCustomEnvVars(target, {
        PROXY_TOKEN: 'attacker',
        TZ: 'Antarctica/Troll',
        MY_CUSTOM: 'foo',
      })

      expect(result).toBe(target) // mutates + returns the same object
      expect(target.PROXY_TOKEN).toBe('real')
      expect(target.TZ).toBe('America/New_York')
      expect(target.MY_CUSTOM).toBe('foo')
      expect(warn).toHaveBeenCalled()
    })

    it('is a no-op when customEnvVars is undefined', () => {
      const target = { A: '1' }
      expect(mergeCustomEnvVars(target, undefined)).toEqual({ A: '1' })
    })
  })

  describe('findReservedEnvVarKeys', () => {
    it('returns only the reserved keys present', () => {
      expect(
        findReservedEnvVarKeys({ PROXY_TOKEN: 'x', AGENT_ID: 'y', SAFE: 'z' }).sort()
      ).toEqual(['AGENT_ID', 'PROXY_TOKEN'])
      expect(findReservedEnvVarKeys({ SAFE: 'z' })).toEqual([])
      expect(findReservedEnvVarKeys(undefined)).toEqual([])
    })
  })

  describe('customEnvVarsSchema', () => {
    it('accepts a map of only non-reserved string vars', () => {
      expect(customEnvVarsSchema.safeParse({ A: '1', B: '2' }).success).toBe(true)
    })

    it('rejects a map containing any reserved key', () => {
      const parsed = customEnvVarsSchema.safeParse({ A: '1', PROXY_BASE_URL: 'http://evil' })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toContain('PROXY_BASE_URL')
      }
    })

    it('rejects non-string values', () => {
      expect(customEnvVarsSchema.safeParse({ A: 1 }).success).toBe(false)
    })
  })
})
