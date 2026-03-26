import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScopeMatchResult } from './scope-matcher'

// Mock DB
const mockAll = vi.fn()
const mockWhere = vi.fn()
const mockDbFrom = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  apiScopePolicies: { accountId: 'account_id', scope: 'scope' },
  mcpToolPolicies: { mcpId: 'mcp_id', toolName: 'tool_name' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

// Mock user settings
const mockGetUserSettings = vi.fn()
vi.mock('@shared/lib/services/user-settings-service', () => ({
  getUserSettings: (...args: unknown[]) => mockGetUserSettings(...args),
}))

import { resolveApiPolicy, resolveMcpPolicy } from './policy-resolver'

describe('resolveApiPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: user settings returns 'review'
    mockGetUserSettings.mockReturnValue({ defaultApiPolicy: 'review' })
  })

  function setupPolicies(policies: Array<{ scope: string; decision: string }>) {
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ all: mockAll })
    mockAll.mockReturnValue(policies.map((p) => ({ policy: p })))
  }

  function makeMatchResult(
    matched: boolean,
    scopes: string[] = [],
    descriptions: Record<string, string> = {}
  ): ScopeMatchResult {
    return { matched, scopes, descriptions }
  }

  it('explicit scope policy "allow" returns "allow"', async () => {
    setupPolicies([{ scope: 'gmail.readonly', decision: 'allow' }])
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(true, ['gmail.readonly']),
      'user-1'
    )
    expect(result.decision).toBe('allow')
    expect(result.resolvedFrom).toBe('scope_policy')
  })

  it('explicit scope policy "block" returns "block"', async () => {
    setupPolicies([{ scope: 'gmail.full', decision: 'block' }])
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(true, ['gmail.full']),
      'user-1'
    )
    expect(result.decision).toBe('block')
  })

  it('explicit scope policy "review" returns "review"', async () => {
    setupPolicies([{ scope: 'gmail.modify', decision: 'review' }])
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(true, ['gmail.modify']),
      'user-1'
    )
    expect(result.decision).toBe('review')
  })

  it('most permissive: allow + review across scopes → "allow"', async () => {
    setupPolicies([
      { scope: 'gmail.readonly', decision: 'allow' },
      { scope: 'gmail.modify', decision: 'review' },
    ])
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(true, ['gmail.readonly', 'gmail.modify']),
      'user-1'
    )
    expect(result.decision).toBe('allow')
  })

  it('most permissive: review + block across scopes → "review"', async () => {
    setupPolicies([
      { scope: 'gmail.readonly', decision: 'review' },
      { scope: 'gmail.full', decision: 'block' },
    ])
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(true, ['gmail.readonly', 'gmail.full']),
      'user-1'
    )
    expect(result.decision).toBe('review')
  })

  it('fallback to account default (scope="*") when no explicit scope policy', async () => {
    setupPolicies([{ scope: '*', decision: 'allow' }])
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(true, ['gmail.send']),
      'user-1'
    )
    expect(result.decision).toBe('allow')
    expect(result.resolvedFrom).toBe('account_default')
  })

  it('fallback to global default when no policies at all', async () => {
    setupPolicies([])
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(true, ['gmail.readonly']),
      'user-1'
    )
    expect(result.decision).toBe('review')
    expect(result.resolvedFrom).toBe('global_default')
  })

  it('global default is "review" by default', async () => {
    setupPolicies([])
    mockGetUserSettings.mockReturnValue({ defaultApiPolicy: 'review' })
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(true, ['gmail.readonly']),
      'user-1'
    )
    expect(result.decision).toBe('review')
  })

  it('unmatched request (matched: false) falls to account default then global', async () => {
    setupPolicies([{ scope: '*', decision: 'block' }])
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(false),
      'user-1'
    )
    expect(result.decision).toBe('block')
    expect(result.resolvedFrom).toBe('account_default')
  })

  it('explicit scope policy NOT overridden by wildcard', async () => {
    // scope 'gmail.full' is blocked, wildcard is allow
    // For gmail.full → block, for gmail.readonly → allow (from wildcard)
    // Most permissive across matched scopes = allow
    setupPolicies([
      { scope: 'gmail.full', decision: 'block' },
      { scope: '*', decision: 'allow' },
    ])
    const result = await resolveApiPolicy(
      'acc-1',
      makeMatchResult(true, ['gmail.full', 'gmail.readonly']),
      'user-1'
    )
    // gmail.full → block, gmail.readonly → allow (wildcard), most permissive = allow
    expect(result.decision).toBe('allow')
  })
})

describe('resolveMcpPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserSettings.mockReturnValue({ defaultApiPolicy: 'review' })
  })

  function setupMcpPolicies(policies: Array<{ toolName: string; decision: string }>) {
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ all: mockAll })
    mockAll.mockReturnValue(policies.map((p) => ({ policy: p })))
  }

  it('explicit tool policy "allow" → "allow"', async () => {
    setupMcpPolicies([{ toolName: 'search', decision: 'allow' }])
    const result = await resolveMcpPolicy('mcp-1', 'search', 'user-1')
    expect(result.decision).toBe('allow')
  })

  it('fallback to MCP default (toolName="*")', async () => {
    setupMcpPolicies([{ toolName: '*', decision: 'block' }])
    const result = await resolveMcpPolicy('mcp-1', 'unknown-tool', 'user-1')
    expect(result.decision).toBe('block')
  })

  it('fallback to global default', async () => {
    setupMcpPolicies([])
    const result = await resolveMcpPolicy('mcp-1', 'search', 'user-1')
    expect(result.decision).toBe('review')
    expect(result.resolvedFrom).toBe('global_default')
  })

  it('null toolName (non-tool-call methods) → MCP default only', async () => {
    setupMcpPolicies([
      { toolName: 'search', decision: 'block' },
      { toolName: '*', decision: 'allow' },
    ])
    const result = await resolveMcpPolicy('mcp-1', null, 'user-1')
    expect(result.decision).toBe('allow')
  })
})
