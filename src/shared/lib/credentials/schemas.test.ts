import { describe, expect, it } from 'vitest'
import { credentialSuggestionsResponseSchema } from './schemas'

describe('credentialSuggestionsResponseSchema', () => {
  it('accepts a search row with no domain and no username', () => {
    const parsed = credentialSuggestionsResponseSchema.parse({
      provider: 'onepassword', providerLabel: '1Password', status: 'ready',
      installable: true, searchable: true, origin: 'https://a.com',
      suggestions: [{ id: 'x', title: 'Obscure Tool' }],
    })
    expect(parsed.suggestions[0].domain).toBeUndefined()
  })
  it('accepts the warming status', () => {
    expect(credentialSuggestionsResponseSchema.parse({
      provider: 'onepassword', providerLabel: '1Password', status: 'warming',
      installable: true, searchable: true, origin: 'https://a.com', suggestions: [],
    }).status).toBe('warming')
  })
})
