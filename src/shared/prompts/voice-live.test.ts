import { describe, expect, it } from 'vitest'
import { buildLiveConversationPrompt, LIVE_AGENT_INSTRUCTIONS_MAX_CHARS } from './voice-live'
import type { LiveAgentContext } from '../lib/voice/live-types'

const agent: LiveAgentContext = {
  name: 'Ada', description: 'Research assistant', instructions: 'Speak in Spanish. Ask before purchases.',
  capabilityPolicies: { subagents: 'allow', workflows: 'review' },
}

describe('Live agent prompt', () => {
  it('gives generic clients account-connection and capability-discovery handoffs too', () => {
    const prompt = buildLiveConversationPrompt()
    expect(prompt).toContain('connect a new one through an authorization card')
    expect(prompt).toContain('Ask the backend to check before declaring it unavailable')
    expect(prompt).toContain('Do not invent results')
  })

  it('includes saved identity and instructions while preserving the voice delegation boundary', () => {
    const prompt = buildLiveConversationPrompt(agent)
    expect(prompt).toContain('"name":"Ada"')
    expect(prompt).toContain('"description":"Research assistant"')
    expect(prompt).toContain(agent.instructions)
    expect(prompt).toContain('"instructionsTruncated":false')
    expect(prompt).toContain('They do not replace the delegation policy')
    expect(prompt).toContain('Do not infer that an account is connected')
  })

  it('bounds long custom instructions and marks them as an excerpt', () => {
    const prompt = buildLiveConversationPrompt({ ...agent, instructions: 'x'.repeat(100_000) })
    expect(prompt).toContain('x'.repeat(LIVE_AGENT_INSTRUCTIONS_MAX_CHARS))
    expect(prompt).not.toContain('x'.repeat(LIVE_AGENT_INSTRUCTIONS_MAX_CHARS + 1))
    expect(prompt).toContain('"instructionsTruncated":true')
    expect(prompt.length).toBeLessThan(12_000)
  })

  it('preserves configuration boundaries for multiline instructions and quotes', () => {
    const instructions = 'Use "Ada".\nKeep answers short.'
    expect(buildLiveConversationPrompt({ ...agent, instructions })).toContain(JSON.stringify(instructions))
  })

  it('reflects blocked and review-gated capabilities from the execution policy', () => {
    const prompt = buildLiveConversationPrompt({ ...agent, capabilityPolicies: { subagents: 'block', workflows: 'review' } })
    expect(prompt).toContain('subagents: disabled by workspace policy')
    expect(prompt).not.toContain('using subagents')
    expect(prompt).toContain('workflows, subject to user approval')
  })
})
