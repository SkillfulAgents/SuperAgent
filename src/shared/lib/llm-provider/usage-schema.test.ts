import { describe, expect, it } from 'vitest'
import { parseCodexUsage, parseGrokUsage, parseKimiUsage } from './usage-schema'

describe('provider allowance normalization', () => {
  it('keeps concurrent Codex windows, reset times and credits with their own units', () => {
    const result = parseCodexUsage({ rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1790800773 },
      secondary_window: { used_percent: 98, limit_window_seconds: 604800 },
    }, credits: { balance: '123.45', unlimited: false } })
    expect(result.limits).toEqual([
      { kind: 'window', id: 'codex-primary', label: '5h', usedPercent: 0, resetsAt: new Date(1790800773000).toISOString() },
      { kind: 'window', id: 'codex-secondary', label: 'Weekly', usedPercent: 98 },
      { kind: 'balance', id: 'credits', label: 'Credits', remaining: 123.45, unit: 'credits' },
    ])
  })
  it('labels a weekly primary window correctly and omits absent or malformed values', () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 604800 }, secondary_window: null }, credits: { balance: 'bad' } }).limits)
      .toEqual([{ kind: 'window', id: 'codex-primary', label: 'Weekly', usedPercent: 25 }])
    expect(parseCodexUsage({ credits: { balance: null } }).status).toBe('unavailable')
    expect(parseCodexUsage({ credits: { balance: '', unlimited: false } }).limits).toEqual([])
    expect(parseCodexUsage({ credits: { balance: '100', unlimited: true } }).limits).toEqual([])
  })
  it('preserves additional Codex buckets rather than assuming two windows', () => {
    expect(parseCodexUsage({ additional_rate_limits: [{ limit_name: 'Spark', rate_limit: { primary_window: { used_percent: 80, limit_window_seconds: 18000 } } }] }).limits[0])
      .toMatchObject({ label: 'Spark · 5h', usedPercent: 80 })
  })
  it('reads the observed Grok response, including an explicit zero prepaid balance', () => {
    const snapshot = parseGrokUsage({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-27T00:24:42Z' }, creditUsagePercent: 1, prepaidBalance: { val: 0 }, onDemandUsed: { val: 900 } } })
    expect(snapshot.limits).toEqual([
      { kind: 'window', id: 'included', label: 'Weekly', usedPercent: 1, resetsAt: '2026-09-27T00:24:42Z' },
      { kind: 'balance', id: 'prepaid', label: 'Prepaid credits', remaining: 0, unit: 'USD' },
    ])
  })
  it('does not invent a Grok percentage or zero credit balance from absent scalars/on-demand usage', () => {
    expect(parseGrokUsage({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' }, onDemandUsed: { val: 80 }, onDemandCap: { val: 100 }, prepaidBalance: {} } }).limits).toEqual([])
    expect(parseGrokUsage({ config: { creditUsagePercent: 0 } }).limits[0]).toMatchObject({ usedPercent: 0 })
  })
  it('accepts legacy Grok amounts only when both included usage and total are known', () => {
    expect(parseGrokUsage({ config: { used: { val: '500' }, monthly_limit: { val: '1000' }, prepaid_balance: { val: '2500' } } }).limits)
      .toEqual([{ kind: 'window', id: 'included', label: 'Monthly', usedPercent: 50 }, { kind: 'balance', id: 'prepaid', label: 'Prepaid credits', remaining: 25, unit: 'USD' }])
    expect(parseGrokUsage({ config: { monthlyLimit: { val: 100 } } }).limits).toEqual([])
  })
})


describe('partial allowance payloads', () => {
  it('omits Codex credits explicitly marked unavailable but preserves an actual exhausted balance', () => {
    expect(parseCodexUsage({ credits: { has_credits: false, balance: '0' } }).limits).toEqual([])
    expect(parseCodexUsage({ credits: { has_credits: true, balance: '0' } }).limits).toEqual([
      { kind: 'balance', id: 'credits', label: 'Credits', remaining: 0, unit: 'credits' },
    ])
  })
  it.each([null, 42, 'weekly', { type: 12 }, { end: 'bad date' }])('retains Grok values with unexpected period metadata (%j)', currentPeriod => {
    const result = parseGrokUsage({ config: { currentPeriod, creditUsagePercent: 85, prepaidBalance: { val: 2500 } } })
    expect(result.limits).toHaveLength(2)
    expect(result.limits[0]).toMatchObject({ usedPercent: 85 })
    expect(result.limits[1]).toMatchObject({ remaining: 25 })
  })
  it.each([[30, 'Monthly'], [14, '14 days']])('labels a %i-day Codex window as %s', (days, label) => {
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 85, limit_window_seconds: Number(days) * 86400 } } }).limits[0].label).toBe(label)
  })
  it('reads Kimi subscription windows as used percentages', () => {
    // Shape observed from a live Kimi Code Plus account.
    const snapshot = parseKimiUsage({ limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '100' } }],
      usages: { limit_5h: { used_ratio: 0.25, reset_time: '2026-09-24T23:58:26Z' }, limit_month_total: { used_ratio: 0, reset_time: '2026-10-25T00:00:00Z' }, limit_month_code: { used_ratio: 0 } } })
    expect(snapshot.limits).toEqual([
      { kind: 'window', id: '5h', label: '5-hour', usedPercent: 25, resetsAt: '2026-09-24T23:58:26Z' },
      { kind: 'window', id: 'month', label: 'Monthly', usedPercent: 0, resetsAt: '2026-10-25T00:00:00Z' },
    ])
    expect(parseKimiUsage({}).status).toBe('unavailable')
  })
})
