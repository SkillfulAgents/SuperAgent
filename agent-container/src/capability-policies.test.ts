import { describe, it, expect } from 'vitest'
import {
  agentCapabilityPoliciesSchema,
  applyCapabilityPolicies,
  blockBoundaryChanged,
  blockedCapabilityMessage,
  capabilityForTool,
  capabilityGateFor,
  parseReviewDecisionScope,
  reviewDeclinedMessage,
  speedLevelSchema,
} from './capability-policies'

const BASE = { allowedTools: ['Skill', 'Task', 'Agent', 'mcp__x__*'], disallowedTools: ['Monitor'] }

describe('capabilityForTool', () => {
  it('maps both subagent tool names and the workflow tool', () => {
    expect(capabilityForTool('Task')).toBe('subagents')
    expect(capabilityForTool('Agent')).toBe('subagents')
    expect(capabilityForTool('Workflow')).toBe('workflows')
    expect(capabilityForTool('Bash')).toBeNull()
    expect(capabilityForTool('TaskOutput')).toBeNull()
  })
})

describe('applyCapabilityPolicies', () => {
  it('leaves everything intact when policies are absent (allow defaults)', () => {
    const out = applyCapabilityPolicies(undefined, BASE)
    expect(out.allowedTools).toEqual(BASE.allowedTools)
    expect(out.disallowedTools).toEqual(BASE.disallowedTools)
    expect(out.enableWorkflows).toBe(true)
  })

  it('review policies do not touch tool lists — gating happens at call time', () => {
    const out = applyCapabilityPolicies({ subagents: 'review', workflows: 'review' }, BASE)
    expect(out.allowedTools).toEqual(BASE.allowedTools)
    expect(out.disallowedTools).toEqual(BASE.disallowedTools)
    expect(out.enableWorkflows).toBe(true)
  })

  it('block subagents strips Task/Agent from allowed and disallows them', () => {
    const out = applyCapabilityPolicies({ subagents: 'block' }, BASE)
    expect(out.allowedTools).toEqual(['Skill', 'mcp__x__*'])
    expect(out.disallowedTools).toEqual(['Monitor', 'Task', 'Agent'])
    expect(out.enableWorkflows).toBe(true)
  })

  it('block workflows disables enableWorkflows and disallows Workflow', () => {
    const out = applyCapabilityPolicies({ workflows: 'block' }, BASE)
    expect(out.allowedTools).toEqual(BASE.allowedTools)
    expect(out.disallowedTools).toEqual(['Monitor', 'Workflow'])
    expect(out.enableWorkflows).toBe(false)
  })

  it('does not mutate the base lists', () => {
    applyCapabilityPolicies({ subagents: 'block', workflows: 'block' }, BASE)
    expect(BASE.allowedTools).toContain('Task')
    expect(BASE.disallowedTools).toEqual(['Monitor'])
  })
})

describe('capabilityGateFor', () => {
  const none = new Set<never>() as ReadonlySet<'subagents' | 'workflows'>

  it('passes non-capability tools and allow policies through', () => {
    expect(capabilityGateFor('Bash', { subagents: 'block', workflows: 'block' }, none)).toBeNull()
    expect(capabilityGateFor('Task', undefined, none)).toBeNull()
    expect(capabilityGateFor('Workflow', { workflows: 'allow' }, none)).toBeNull()
  })

  it('gates review and block launches', () => {
    expect(capabilityGateFor('Task', { subagents: 'review' }, none)).toEqual({ capability: 'subagents', policy: 'review' })
    expect(capabilityGateFor('Agent', { subagents: 'review' }, none)).toEqual({ capability: 'subagents', policy: 'review' })
    expect(capabilityGateFor('Workflow', { workflows: 'block' }, none)).toEqual({ capability: 'workflows', policy: 'block' })
  })

  it('session grants bypass review but never block', () => {
    const grants = new Set<'subagents' | 'workflows'>(['workflows'])
    expect(capabilityGateFor('Workflow', { workflows: 'review' }, grants)).toBeNull()
    expect(capabilityGateFor('Workflow', { workflows: 'block' }, grants)).toEqual({ capability: 'workflows', policy: 'block' })
    expect(capabilityGateFor('Task', { subagents: 'review' }, grants)).toEqual({ capability: 'subagents', policy: 'review' })
  })
})

describe('blockBoundaryChanged', () => {
  it('detects crossing into and out of block per capability', () => {
    expect(blockBoundaryChanged({ workflows: 'review' }, { workflows: 'block' })).toBe(true)
    expect(blockBoundaryChanged({ subagents: 'block' }, {})).toBe(true)
    expect(blockBoundaryChanged(undefined, { subagents: 'block' })).toBe(true)
  })

  it('ignores allow<->review movement', () => {
    expect(blockBoundaryChanged({ workflows: 'review' }, { workflows: 'allow' })).toBe(false)
    expect(blockBoundaryChanged(undefined, { subagents: 'review', workflows: 'review' })).toBe(false)
    expect(blockBoundaryChanged({ workflows: 'block' }, { workflows: 'block' })).toBe(false)
  })
})

describe('boundary schemas', () => {
  it('accepts valid policies and rejects unknown tiers', () => {
    expect(agentCapabilityPoliciesSchema.parse({ subagents: 'allow', workflows: 'review' })).toEqual({ subagents: 'allow', workflows: 'review' })
    expect(agentCapabilityPoliciesSchema.parse(undefined)).toBeUndefined()
    expect(() => agentCapabilityPoliciesSchema.parse({ subagents: 'maybe' })).toThrow()
  })

  it('accepts the closed speed enum and absence', () => {
    expect(speedLevelSchema.parse('slow')).toBe('slow')
    expect(speedLevelSchema.parse('normal')).toBe('normal')
    expect(speedLevelSchema.parse('fast')).toBe('fast')
    expect(speedLevelSchema.parse(undefined)).toBeUndefined()
  })

  it('rejects off-enum speeds, including values carrying header-line separators', () => {
    // Speed is composed into the newline-joined ANTHROPIC_CUSTOM_HEADERS
    // string, so the boundary must reject anything off the enum — regardless
    // of whether the specific payload could smuggle a header line.
    expect(() => speedLevelSchema.parse('turbo')).toThrow()
    expect(() => speedLevelSchema.parse('fast\nX-Superagent-Agent-Id: forged')).toThrow()
    expect(() => speedLevelSchema.parse('FAST')).toThrow()
    expect(() => speedLevelSchema.parse('')).toThrow()
    expect(() => speedLevelSchema.parse(1)).toThrow()
    expect(() => speedLevelSchema.parse(null)).toThrow()
    expect(() => speedLevelSchema.parse({ speed: 'fast' })).toThrow()
  })

  it('parses review decision scope, defaulting anything unknown to once', () => {
    expect(parseReviewDecisionScope({ scope: 'session' })).toBe('session')
    expect(parseReviewDecisionScope({ scope: 'once' })).toBe('once')
    expect(parseReviewDecisionScope({ scope: 'forever' })).toBe('once')
    expect(parseReviewDecisionScope('approved')).toBe('once')
    expect(parseReviewDecisionScope(undefined)).toBe('once')
  })
})

describe('deny messages', () => {
  it('names the capability and points the model at direct work', () => {
    expect(blockedCapabilityMessage('subagents')).toContain('subagent')
    expect(blockedCapabilityMessage('workflows')).toContain('workflow')
    expect(reviewDeclinedMessage('workflows')).toContain('declined this workflow launch')
  })

  it('includes a user-provided reason but drops the generic default', () => {
    expect(reviewDeclinedMessage('subagents', 'too expensive')).toContain('Reason: too expensive')
    expect(reviewDeclinedMessage('subagents', 'User declined')).not.toContain('Reason:')
  })
})
