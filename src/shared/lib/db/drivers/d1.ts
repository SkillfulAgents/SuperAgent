/**
 * Cloudflare D1: asynchronous, `batch()` for atomic multi-statement writes,
 * no interactive transactions. The binding comes from the Worker's env.
 */
import type { AnyD1Database } from 'drizzle-orm/d1'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../schema'
import type { DatabaseDriver } from './types'

export function d1(binding: AnyD1Database): DatabaseDriver {
  return {
    name: 'd1',
    open() {
      return {
        db: drizzle(binding, { schema }) as never,
        close() {},
      }
    },
  }
}
