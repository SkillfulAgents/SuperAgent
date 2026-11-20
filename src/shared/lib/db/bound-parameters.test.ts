import { afterEach, expect, it } from 'vitest'
import { eq, or } from 'drizzle-orm'
import { setMaxBoundParameters, withInList } from './bound-parameters'
import { agents } from './schema'
import { perTestDatabase } from './testing/per-test-database'

const database = perTestDatabase()
afterEach(() => setMaxBoundParameters(undefined))

it('counts repeated predicates in a subquery and optional binds in the outer query', async () => {
  setMaxBoundParameters(100)
  const rows = ['id-0', 'id-1'].map(slug => ({ slug, name: 'Match', createdAt: new Date() }))
  await database.db.insert(agents).values(rows).run()
  const ids = Array.from({ length: 49 }, (_, i) => `id-${i}`)

  const find = (name?: string) => withInList(agents.slug, ids, matches => {
    const named = database.db.select({ slug: agents.slug, name: agents.name })
      .from(agents).where(or(matches, matches)).as('named')
    return database.db.select({ slug: named.slug }).from(named)
      .where(name === undefined ? undefined : eq(named.name, name))
      .orderBy(named.slug).limit(10).offset(1)
  })

  // Two copies of 49 IDs plus LIMIT and OFFSET exactly fill the statement.
  const direct = find()
  const packed = find('Match')
  expect(direct.toSQL().params).toEqual([...ids, ...ids, 10, 1])
  expect(packed.toSQL().params).toEqual([JSON.stringify(ids), JSON.stringify(ids), 'Match', 10, 1])
  expect(await packed.all()).toEqual([{ slug: 'id-1' }])
  expect(await direct.all()).toEqual([{ slug: 'id-1' }])
})
