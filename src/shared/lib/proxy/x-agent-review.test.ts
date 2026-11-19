import { describe, expect, it } from 'vitest'
import { xAgentAllowState, xAgentReviewNamesTarget, type XAgentReview } from './x-agent-review'

describe('xAgentReviewNamesTarget', () => {
  it.each([
    ['read', true],
    ['invoke', true],
    ['list', false],
    ['create', false],
  ] as const)('a %s request names another agent: %s', (operation, names) => {
    expect(xAgentReviewNamesTarget({ operation })).toBe(names)
  })
})

describe('xAgentAllowState', () => {
  const read: XAgentReview = { operation: 'read', targetAgentSlug: 'beta', targetAgentName: 'Beta' }
  const team = { isAuthMode: true, rolesReady: true, review: read }

  it.each([
    ['the desktop app', { ...team, isAuthMode: false, usesCaller: false, usesTarget: false }],
    ['a list request', { ...team, usesCaller: true, usesTarget: false, review: { operation: 'list', targetAgentSlug: '', targetAgentName: '' } }],
    ['a create request', { ...team, usesCaller: true, usesTarget: false, review: { operation: 'create', targetAgentSlug: 'new', targetAgentName: 'New' } }],
    ['someone who uses both agents', { ...team, usesCaller: true, usesTarget: true }],
  ] as const)('allows %s', (_name, input) => {
    expect(xAgentAllowState(input)).toEqual({ canAllow: true, lacking: [] })
  })

  it('hides Allow, and names nobody, while roles load', () => {
    expect(xAgentAllowState({ ...team, rolesReady: false, usesCaller: true, usesTarget: true })).toEqual({ canAllow: false, lacking: [] })
  })

  it.each([
    ['only the caller', true, false, ['Beta']],
    ['only the target', false, true, ['this agent']],
    ['neither agent', false, false, ['this agent', 'Beta']],
  ] as const)('names what someone who uses %s lacks', (_name, usesCaller, usesTarget, lacking) => {
    expect(xAgentAllowState({ ...team, usesCaller, usesTarget })).toEqual({ canAllow: false, lacking })
  })

  it.each(['', ' '])('names the target by its slug when its name is %j', (targetAgentName) => {
    expect(xAgentAllowState({ ...team, usesCaller: true, usesTarget: false, review: { ...read, targetAgentName } }).lacking).toEqual(['beta'])
  })
})
