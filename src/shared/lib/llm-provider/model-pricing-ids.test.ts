import { describe, expect, it } from 'vitest'
import {
  BEDROCK_CATALOG,
  CLAUDE_BARE_CATALOG,
  OPENROUTER_CATALOG,
  PLATFORM_CATALOG,
} from './builtin-catalogs'
import { VENDOR_PREFIXES, canonicalPricingId, modelPricingCandidates } from './model-pricing-ids'
import { pricingFor } from './model-pricing-lookup'

describe('model pricing ids', () => {
  it('lists the vendor prefix of every slash-qualified built-in id that has a shared rate', () => {
    const missing = [BEDROCK_CATALOG, CLAUDE_BARE_CATALOG, OPENROUTER_CATALOG, PLATFORM_CATALOG]
      .flat()
      .map((model) => model.id)
      .filter((id) => id.includes('/') && pricingFor(id) !== undefined)
      .filter((id) => !VENDOR_PREFIXES.has(id.slice(0, id.lastIndexOf('/'))))
    // A built-in missing here would keep its own override key instead of sharing the bare model's.
    expect(missing).toEqual([])
  })

  it('collapses a vendor prefix when writing, and any prefix when reading a fallback rate', () => {
    expect(canonicalPricingId('openai/gpt-5.5-20260423')).toBe('gpt-5.5')
    expect(canonicalPricingId('litellm/openai/gpt-5.5')).toBe('litellm/openai/gpt-5.5')
    expect(modelPricingCandidates('azure/gpt-5.5')).toEqual(['azure/gpt-5.5', 'gpt-5.5'])
    expect(pricingFor('azure/gpt-5.5')).toEqual(pricingFor('gpt-5.5'))
  })

  it('treats an id that names an Object.prototype member as an unknown model', () => {
    expect(modelPricingCandidates('constructor')).toEqual(['constructor'])
    expect(pricingFor('constructor')).toBeUndefined()
    expect(pricingFor('vendor/toString')).toBeUndefined()
  })

  it('prices observed Grok subscription deployment IDs at the shared API-equivalent rate', () => {
    expect(pricingFor('grok-4.7-build')).toEqual(pricingFor('grok-4.7'))
    expect(pricingFor('grok-4.6-build')).toEqual(pricingFor('grok-4.6'))
    expect(canonicalPricingId('grok-4.7-build')).toBe('grok-4.7')
  })

  it('prices the Kimi subscription K3 slugs at the shared Kimi K3 rate', () => {
    expect(pricingFor('k3')).toEqual(pricingFor('kimi-k3'))
    expect(pricingFor('k3-256k')).toEqual(pricingFor('kimi-k3'))
  })

  it('answers repeated lookups with the same candidate list', () => {
    expect(modelPricingCandidates('anthropic/claude-sonnet-5-20260630')).toBe(
      modelPricingCandidates('anthropic/claude-sonnet-5-20260630'),
    )
    // The write-key expansion is cached apart from the read one.
    expect(modelPricingCandidates('azure/gpt-5.5', { vendorPrefixesOnly: true })).toEqual(['azure/gpt-5.5'])
    expect(modelPricingCandidates('azure/gpt-5.5')).toContain('gpt-5.5')
  })
})
