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

// Mock scope→label lookup (real policy-sentinels labelDefaultKey is used as-is)
const mockGetScopeLabel = vi.fn()
vi.mock('./scope-metadata', () => ({
  getScopeLabel: (...args: unknown[]) => mockGetScopeLabel(...args),
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

describe('resolveApiPolicy — label-default tier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserSettings.mockReturnValue({ defaultApiPolicy: 'review' })
    // Default: scopes have no label unless a test sets one
    mockGetScopeLabel.mockReturnValue(undefined)
  })

  function setupPolicies(policies: Array<{ scope: string; decision: string }>) {
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ all: mockAll })
    mockAll.mockReturnValue(policies.map((p) => ({ policy: p })))
  }
  function labelMap(map: Record<string, string>) {
    mockGetScopeLabel.mockImplementation((_toolkit: string, scope: string) => map[scope])
  }
  const match = (scopes: string[]): ScopeMatchResult => ({
    matched: true,
    scopes,
    descriptions: {},
  })

  it('applies the account label default (e.g. "*read" → allow)', async () => {
    labelMap({ 'gmail.readonly': 'read' })
    setupPolicies([{ scope: '*read', decision: 'allow' }])
    const r = await resolveApiPolicy('acc-1', match(['gmail.readonly']), 'user-1', 'gmail')
    expect(r.decision).toBe('allow')
    expect(r.resolvedFrom).toBe('account_label_default')
  })

  it('a "*destructive" → block label default blocks (sole resolution)', async () => {
    labelMap({ 'gmail.full': 'destructive' })
    setupPolicies([{ scope: '*destructive', decision: 'block' }])
    const r = await resolveApiPolicy('acc-1', match(['gmail.full']), 'user-1', 'gmail')
    expect(r.decision).toBe('block')
    expect(r.resolvedFrom).toBe('account_label_default')
  })

  it('explicit scope policy beats the label default', async () => {
    labelMap({ 'gmail.readonly': 'read' })
    setupPolicies([
      { scope: 'gmail.readonly', decision: 'block' },
      { scope: '*read', decision: 'allow' },
    ])
    const r = await resolveApiPolicy('acc-1', match(['gmail.readonly']), 'user-1', 'gmail')
    expect(r.decision).toBe('block')
    expect(r.resolvedFrom).toBe('scope_policy')
  })

  it('label default beats the account-wide "*" default', async () => {
    labelMap({ 'gmail.readonly': 'read' })
    setupPolicies([
      { scope: '*read', decision: 'allow' },
      { scope: '*', decision: 'block' },
    ])
    const r = await resolveApiPolicy('acc-1', match(['gmail.readonly']), 'user-1', 'gmail')
    expect(r.decision).toBe('allow')
    expect(r.resolvedFrom).toBe('account_label_default')
  })

  it('REGRESSION: a labeled scope with NO label rows behaves exactly like legacy (account "*")', async () => {
    // The scope HAS a risk label, but the account was never seeded with '*read' etc.
    // It must fall straight through to the account '*' default — i.e. existing
    // accounts are never silently migrated by the label tier.
    labelMap({ 'gmail.readonly': 'read' })
    setupPolicies([{ scope: '*', decision: 'block' }])
    const r = await resolveApiPolicy('acc-1', match(['gmail.readonly']), 'user-1', 'gmail')
    expect(r.decision).toBe('block')
    expect(r.resolvedFrom).toBe('account_default')
  })

  it('an unlabeled scope skips the label tier even if label rows exist', async () => {
    labelMap({}) // getScopeLabel → undefined for this scope
    setupPolicies([
      { scope: '*read', decision: 'allow' },
      { scope: '*', decision: 'review' },
    ])
    const r = await resolveApiPolicy('acc-1', match(['weird.uncurated.scope']), 'user-1', 'gmail')
    expect(r.decision).toBe('review')
    expect(r.resolvedFrom).toBe('account_default')
  })

  it('most permissive across mixed-label sufficient scopes', async () => {
    // gmail.send (write→block) OR gmail.readonly (read→allow) suffice for the call;
    // the most permissive wins, matching the "sufficient scopes" semantics.
    labelMap({ 'gmail.send': 'write', 'gmail.readonly': 'read' })
    setupPolicies([
      { scope: '*write', decision: 'block' },
      { scope: '*read', decision: 'allow' },
    ])
    const r = await resolveApiPolicy(
      'acc-1',
      match(['gmail.send', 'gmail.readonly']),
      'user-1',
      'gmail',
    )
    expect(r.decision).toBe('allow')
  })

  it('without a toolkit the label tier is skipped (legacy callers)', async () => {
    labelMap({ 'gmail.readonly': 'read' })
    setupPolicies([
      { scope: '*read', decision: 'allow' },
      { scope: '*', decision: 'block' },
    ])
    // no toolkit arg → getScopeLabel never consulted → falls to account '*'
    const r = await resolveApiPolicy('acc-1', match(['gmail.readonly']), 'user-1')
    expect(r.decision).toBe('block')
    expect(r.resolvedFrom).toBe('account_default')
    expect(mockGetScopeLabel).not.toHaveBeenCalled()
  })
})
