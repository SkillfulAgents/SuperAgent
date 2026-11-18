import { describe, expect, it } from 'vitest'
import { buildLiveConversationPrompt, LIVE_SETTING_INSTRUCTIONS_MAX_CHARS } from './voice-live'
import type { LiveAgentContext, LiveConversationSetting } from '../lib/voice/live-types'

const agent: LiveAgentContext = {
  name: 'Ada', description: 'Research assistant', instructions: 'Be concise.',
  capabilityPolicies: { subagents: 'allow', workflows: 'allow' },
}

/** A stand-in for what an integration supplies; the prompt module knows no family. */
const room: LiveConversationSetting = {
  policy: { turnTaking: 'Room rules: default to silence; answer only when addressed.', spokenUpdates: 'Room updates: speak once for an outcome.' },
  instructions: 'You are in a call under the name "Ada (Gamut)".\nParticipants update: in the call now: Iddo (host), Maya.',
}

describe('Live prompt with a conversation setting', () => {
  it("swaps in the setting's turn-taking and update rules and appends its instructions", () => {
    const prompt = buildLiveConversationPrompt({ ...agent, setting: room })
    expect(prompt).toContain('Room rules: default to silence')
    expect(prompt).toContain('Room updates: speak once for an outcome.')
    expect(prompt).toContain('under the name "Ada (Gamut)"')
    expect(prompt).toContain('in the call now: Iddo (host), Maya')
    // The one-on-one rules are replaced, not stacked.
    expect(prompt).not.toContain('Use moderate backchannels')
    expect(prompt).not.toContain('summarize any outcome not yet covered')
    // Shared layers are still there, after the policy and before the identity block.
    expect(prompt).toContain('Delegation policy:')
    expect(prompt.indexOf('Room rules')).toBeLessThan(prompt.indexOf('Delegation policy:'))
    expect(prompt.indexOf('under the name')).toBeLessThan(prompt.indexOf('Agent identity and preferences'))
  })
  it('bounds the instructions an integration can add', () => {
    const prompt = buildLiveConversationPrompt({ ...agent, setting: { ...room, instructions: '§'.repeat(10_000) } })
    expect(prompt.match(/§+/)?.[0].length).toBe(LIVE_SETTING_INSTRUCTIONS_MAX_CHARS)
  })
  it('leaves the one-on-one prompt unchanged without a setting', () => {
    const prompt = buildLiveConversationPrompt(agent)
    expect(prompt).not.toContain('Room rules')
    expect(prompt).toContain('Use moderate backchannels')
    expect(prompt).toContain('summarize any outcome not yet covered')
  })
})
