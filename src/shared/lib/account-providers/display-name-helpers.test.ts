import { describe, it, expect, vi } from 'vitest'
import { resolveDisplayName } from './display-name-helpers'

type Call = Parameters<Parameters<typeof resolveDisplayName>[0]>[0]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function bodyOf(call: Call): unknown {
  return JSON.parse(new TextDecoder().decode(call.body!))
}

describe('resolveDisplayName for plaid', () => {
  it('names the account after the institution on the Item', async () => {
    const makeApiCall = vi.fn(async (_call: Call) => jsonResponse({ item: { item_id: 'i1', institution_id: 'ins_3', institution_name: 'Chase' } }))
    await expect(resolveDisplayName(makeApiCall, 'ca_1', 'plaid', 'Plaid')).resolves.toBe('Chase')

    expect(makeApiCall).toHaveBeenCalledTimes(1)
    const call = makeApiCall.mock.calls[0][0]
    expect(call.method).toBe('POST')
    expect(call.targetUrl).toBe('https://production.plaid.com/item/get')
    expect(call.toolkitSlug).toBe('plaid')
    expect(bodyOf(call)).toEqual({})
  })

  it('falls back to the institution lookup when the Item carries only the id', async () => {
    const makeApiCall = vi.fn(async (call: Call) =>
      call.targetUrl.endsWith('/item/get')
        ? jsonResponse({ item: { item_id: 'i1', institution_id: 'ins_3' } })
        : jsonResponse({ institution: { institution_id: 'ins_3', name: 'Bank of America' } }),
    )
    await expect(resolveDisplayName(makeApiCall, 'ca_1', 'plaid', 'Plaid')).resolves.toBe('Bank of America')

    expect(makeApiCall).toHaveBeenCalledTimes(2)
    const lookup = makeApiCall.mock.calls[1][0]
    expect(lookup.targetUrl).toBe('https://production.plaid.com/institutions/get_by_id')
    expect(bodyOf(lookup)).toEqual({ institution_id: 'ins_3', country_codes: ['US'] })
  })

  it('keeps the fallback name when Plaid refuses or the shape is unexpected', async () => {
    const refused = vi.fn(async () => jsonResponse({ error_code: 'ITEM_LOGIN_REQUIRED' }, 400))
    await expect(resolveDisplayName(refused, 'ca_1', 'plaid', 'Plaid')).resolves.toBe('Plaid')

    const odd = vi.fn(async () => jsonResponse({ item: 'nope' }))
    await expect(resolveDisplayName(odd, 'ca_1', 'plaid', 'Plaid')).resolves.toBe('Plaid')

    const thrown = vi.fn(async () => { throw new Error('hop down') })
    await expect(resolveDisplayName(thrown, 'ca_1', 'plaid', 'Plaid')).resolves.toBe('Plaid')
  })

  it('does not call out for toolkits without a resolver', async () => {
    const makeApiCall = vi.fn()
    await expect(resolveDisplayName(makeApiCall, 'ca_1', 'stripe', 'Stripe')).resolves.toBe('Stripe')
    expect(makeApiCall).not.toHaveBeenCalled()
  })
})
