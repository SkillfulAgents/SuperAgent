/**
 * Profile keying.
 *
 * The key is the entire safety argument for handing a pre-warmed process to a
 * session: equal keys are treated as "these two sessions would build an
 * identical query". Anything that reaches the query but not the key is a way
 * for a session to run under a configuration it did not ask for.
 */
import { describe, it, expect } from 'vitest'
import { warmProfileKey, warmProfileSchema } from './warm-profile'

const base = warmProfileSchema.parse({ model: 'claude-opus-4-8', effort: 'high' })

describe('warmProfileKey', () => {
  // Regression: JSON.stringify's array-replacer form is a whitelist applied at
  // every depth, so nested objects collapsed to `{}` and an allow-policy
  // profile keyed identically to a block-policy one.
  it('separates profiles that differ only in a nested capability policy', () => {
    const allow = warmProfileKey(
      warmProfileSchema.parse({ ...base, capabilityPolicies: { subagents: 'allow', workflows: 'allow' } })
    )
    const block = warmProfileKey(
      warmProfileSchema.parse({ ...base, capabilityPolicies: { subagents: 'block', workflows: 'block' } })
    )

    expect(allow).not.toBe(block)
  })

  it('separates profiles that differ only in a nested custom env var', () => {
    const one = warmProfileKey(warmProfileSchema.parse({ ...base, customEnvVars: { API_BASE: 'one' } }))
    const two = warmProfileKey(warmProfileSchema.parse({ ...base, customEnvVars: { API_BASE: 'two' } }))

    expect(one).not.toBe(two)
  })

  it('keys the same configuration identically regardless of insertion order', () => {
    const a = warmProfileKey(
      warmProfileSchema.parse({ model: 'm', effort: 'high', customEnvVars: { A: '1', B: '2' } })
    )
    const b = warmProfileKey(
      warmProfileSchema.parse({ customEnvVars: { B: '2', A: '1' }, effort: 'high', model: 'm' })
    )

    expect(a).toBe(b)
  })

  // Array order is meaningful — the hints are concatenated into the prompt.
  it('separates profiles whose prompt hints differ only in order', () => {
    const a = warmProfileKey(warmProfileSchema.parse({ ...base, modelPromptHints: ['one', 'two'] }))
    const b = warmProfileKey(warmProfileSchema.parse({ ...base, modelPromptHints: ['two', 'one'] }))

    expect(a).not.toBe(b)
  })

  it('separates profiles whose model-backed subagent catalogs differ', () => {
    const gpt = warmProfileKey(
      warmProfileSchema.parse({
        ...base,
        subagentModels: [{ id: 'openai/gpt-5.5', label: 'GPT 5.5' }],
      })
    )
    const grok = warmProfileKey(
      warmProfileSchema.parse({
        ...base,
        subagentModels: [{ id: 'x-ai/grok-4.5', label: 'Grok 4.5' }],
      })
    )

    expect(gpt).not.toBe(grok)
  })

  it('treats an absent field and an explicitly undefined one as the same profile', () => {
    const absent = warmProfileKey(warmProfileSchema.parse({ model: 'm' }))
    const undef = warmProfileKey(warmProfileSchema.parse({ model: 'm', effort: undefined, speed: undefined }))

    expect(absent).toBe(undef)
  })
})
