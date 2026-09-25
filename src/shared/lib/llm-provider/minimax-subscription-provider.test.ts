import { describe, expect, it } from 'vitest'
import { MinimaxSubscriptionLlmProvider } from './minimax-subscription-provider'

describe('MinimaxSubscriptionLlmProvider', () => {
  it('tells the agent to call the plan media endpoints with the session credential', () => {
    const prompt = new MinimaxSubscriptionLlmProvider().mediaPrompt
    expect(prompt).toContain('"/llm-runtime/resolve"')
    expect(prompt).toContain('proxy.baseUrl with its trailing "/anthropic/v1" removed')
    expect(prompt).toContain('/v1/image_generation')
    expect(prompt).toContain('/v1/t2a_v2')
    expect(prompt).toContain('"model":"MiniMax-Hailuo-2.3"')
  })
})
