import { describe, it } from 'vitest'
// eslint ships no bundled types and @types/eslint isn't a dependency; the
// RuleTester runtime API is all we need here.
// @ts-ignore -- no type declarations for 'eslint'
import { RuleTester } from 'eslint'
import rule from '../../../../eslint-rules/no-sync-drizzle-terminator.js'

// Drive ESLint's RuleTester through vitest's test hooks.
RuleTester.describe = describe as unknown as typeof RuleTester.describe
RuleTester.it = it as unknown as typeof RuleTester.it

const ruleTester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

const sync = { messageId: 'sync' }

ruleTester.run('no-sync-drizzle-terminator', rule as unknown as Parameters<RuleTester['run']>[1], {
  valid: [
    // Awaited, in every spelling.
    { code: 'async function f() { const rows = await db.select().from(t).where(w).all(); return rows }' },
    { code: 'async function f() { return db.select().from(t).get() }' },
    { code: 'const f = async () => db.delete(t).where(w).run()' },
    { code: 'async function f() { const [a, b] = await Promise.all([db.select().from(t).all(), db.select().from(u).all()]) }' },
    { code: 'async function f() { await Promise.allSettled([db.delete(t).run()]) }' },
    { code: 'db.select().from(t).all().then((rows) => use(rows))' },
    { code: 'async function f() { const r = await getDb().run(sql`DELETE FROM x`) }' },
    { code: 'async function f() { const r = await getDb().select().from(t).get() }' },
    { code: 'async function f() { const r = await insertWhere(t, row, cond).onConflictDoNothing().run() }' },
    { code: 'class A { async list() { return this.db.select().from(t).all() } }' },
    { code: 'async function f(tx) { return tx.insert(t).values(v).run() }' },
    // Not a drizzle chain: other objects have .get()/.run()/.all() too.
    { code: 'const v = cache.get(key)' },
    { code: "const h = c.req.raw.headers.get('x-thing')" },
    { code: 'const out = task.run()' },
    { code: 'const rows = this.rows.all()' },
    // A builder that is not terminated is a value, not a query.
    { code: 'await batch([db.delete(t).where(w), db.insert(t).values(v)])' },
    // A transaction callback stays synchronous (the batch helper's, on better-sqlite3).
    { code: 'db.transaction((tx) => { tx.insert(t).values(v).run(); return tx.select().from(t).all() })' },
    { code: 'function f() { return db.transaction(() => db.select().from(t).get()) }' },
  ],
  invalid: [
    { code: 'function f() { return db.select().from(t).all() }', errors: [sync] },
    { code: 'const rows = db.select().from(t).where(w).all()', errors: [sync] },
    { code: 'async function f() { db.delete(t).where(w).run() }', errors: [sync] },
    { code: 'async function f() { const row = db.select().from(t).get() }', errors: [sync] },
    { code: 'async function f() { const r = getDb().get(sql`SELECT 1`) }', errors: [sync] },
    { code: 'async function f() { const r = insertWhere(t, row, cond).run() }', errors: [sync] },
    { code: 'class A { list() { return this.db.select().from(t).all() } }', errors: [sync] },
    { code: 'function f(tx) { tx.insert(t).values(v).run() }', errors: [sync] },
    // A sync arrow body is a return from a sync function.
    { code: 'const f = () => db.select().from(t).all()', errors: [sync] },
    // `void` discards the Promise; it does not wait for it.
    { code: 'async function f() { void db.delete(t).run() }', errors: [sync] },
    // An array that is not handed to Promise.all is not awaited.
    { code: 'const rows = [db.select().from(t).all()]', errors: [sync] },
    // A guard on the bare value is the bug the rule exists for.
    { code: 'if (db.select().from(t).get()) { x() }', errors: [sync] },
    // Every call counts.
    {
      code: 'function f() { const a = db.select().from(t).all(); const b = db.select().from(u).get(); return [a, b] }',
      errors: [sync, sync],
    },
  ],
})
