import { describe, expect, it } from 'vitest'
import { buildLiveConversationPrompt, LIVE_AGENT_INSTRUCTIONS_MAX_CHARS, LIVE_REQUEST_PROMPT, LIVE_REQUEST_PROMPT_LEGACY } from './voice-live'
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

  it.each([undefined, agent])('keeps capability discovery and execution boundaries in both startup paths', (context) => {
    const prompt = buildLiveConversationPrompt(context)
    expect(prompt).toContain('This summary is not exhaustive')
    expect(prompt).toContain("delegate the user's original question or task")
    expect(prompt).toContain('tools, skills, configuration, and documentation')
    expect(prompt).toContain('not permission to execute')
    expect(prompt).toContain('Respect confirmed limitations and policy blocks')
    expect(prompt).toContain('backend must consult current product documentation and runtime capabilities')
  })

  it('covers persistent and asynchronous work and qualifies deployment-dependent capabilities', () => {
    const prompt = buildLiveConversationPrompt(agent)
    expect(prompt).toContain('recall past conversations, save or forget memories')
    expect(prompt).toContain('must reach the backend to persist')
    expect(prompt).toContain('reusable skills')
    expect(prompt).toContain('dashboards and automatically refreshed home-screen widgets')
    expect(prompt).toContain('pause and resume this same conversation later')
    expect(prompt).toContain('Chat integrations')
    expect(prompt).toContain('other agents')
    expect(prompt).toContain('Conditional capabilities: ask the backend to verify availability')
    expect(prompt).toContain('These depend on the host/platform configuration')
    expect(prompt).toContain('Preserve requests for approval and cost disclosures')
    expect(prompt).toContain('never ask the user to speak passwords or tokens')
  })

  it('rewrites the user\'s words without deciding whether to send them or inventing authorization', () => {
    expect(LIVE_REQUEST_PROMPT).toContain('it is always sent')
    expect(LIVE_REQUEST_PROMPT).toContain('a rewrite of these words and nothing else')
    expect(LIVE_REQUEST_PROMPT).toContain('an incomplete request is sent as is and the backend can ask')
    expect(LIVE_REQUEST_PROMPT).toContain('requests to stop or cancel work are all messages for the backend')
    expect(LIVE_REQUEST_PROMPT).toContain('a capability question alone does not authorize execution')
    expect(LIVE_REQUEST_PROMPT).toContain('Never add a task that appears only in voice_assistant lines')
    expect(LIVE_REQUEST_PROMPT).toContain('mode: "queue" when the user is adding to work in progress')
    expect(LIVE_REQUEST_PROMPT).not.toMatch(/\bclarify\b/)
    expect(LIVE_REQUEST_PROMPT_LEGACY).toContain('action (message, cancel, clarify, or none)')
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
