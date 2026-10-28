/**
 * libsql: an in-process, asynchronous SQLite driver with `batch()` and no
 * interactive transactions, the same shape as Cloudflare D1. CI runs the
 * test suite against it so code that only works on better-sqlite3 fails
 * there. `@libsql/client` is a devDependency: this module must stay out of
 * the production import graph (the test helper is its only importer).
 */
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../schema'
import type { DatabaseDriver } from './types'

/**
 * @param url `':memory:'` for a private in-memory database, or a `file:` URL
 */
export function libsql(url: string): DatabaseDriver {
  return {
    name: 'libsql',
    async open() {
      const client = createClient({ url })
      // Match better-sqlite3's pragmas: libsql leaves foreign keys off by default.
      await client.execute('PRAGMA foreign_keys = ON')
      if (url.startsWith('file:')) await client.execute('PRAGMA journal_mode = WAL')
      return {
        db: drizzle(client, { schema }),
        close: () => {
          client.close()
        },
      }
    },
  }
}
