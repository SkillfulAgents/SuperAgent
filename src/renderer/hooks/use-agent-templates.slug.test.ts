import { describe, expect, it } from 'vitest'
import { slugFromAgentPath } from './use-agent-templates'

describe('slugFromAgentPath', () => {
  it('strips agents/ prefix and trailing slash', () => {
    expect(slugFromAgentPath('agents/research-bot/')).toBe('research-bot')
  })

  it('handles path without trailing slash', () => {
    expect(slugFromAgentPath('agents/foo')).toBe('foo')
  })

  it('leaves inner segments intact', () => {
    expect(slugFromAgentPath('agents/my.agent-v2/')).toBe('my.agent-v2')
  })

  it('keeps nested segments after the agents/ prefix', () => {
    expect(slugFromAgentPath('agents/a/b/')).toBe('a/b')
  })

  it('returns empty for agents/ alone', () => {
    expect(slugFromAgentPath('agents/')).toBe('')
  })

  it('leaves non-agents paths unchanged', () => {
    expect(slugFromAgentPath('skills/foo/')).toBe('skills/foo')
  })
})
