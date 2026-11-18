import { describe, expect, it } from 'vitest'
import { serverFactsSchema } from '@shared/lib/facts/facts-schema'
import { getServerFacts } from '@shared/lib/facts/server-facts'
import serverFacts from './server-facts'

describe('GET /api/server-facts', () => {
  it('answers with the facts the web build inlines, in the shape a desktop app reads', async () => {
    const res = await serverFacts.request('/')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(serverFactsSchema.parse(body)).toEqual(getServerFacts())
  })
})
