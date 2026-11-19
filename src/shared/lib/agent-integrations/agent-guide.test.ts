import { expect, it } from 'vitest'
import { agentIntegrationRegistry } from './registry'

// An agent sets a provider up through the provider's own setup hooks; the
// guide is the one thing a new provider adds for that.
it('every provider tells an agent how to set it up', () => {
  const providers = agentIntegrationRegistry.listDefinitions().map(definition => definition.provider)
  expect(providers.length).toBeGreaterThan(0)
  for (const provider of providers) {
    expect(agentIntegrationRegistry.getProvider(provider).setup?.agentGuide, provider).toBeTruthy()
  }
})
