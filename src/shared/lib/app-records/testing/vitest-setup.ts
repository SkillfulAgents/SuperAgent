/**
 * Every test starts with a fresh, empty in-memory app record store, so code
 * that reads settings or host records works without each test installing one
 * (production entry points install the database store after openDatabase()).
 * A file that seeds records once in `beforeAll` calls
 * `keepAppRecordStoreAcrossTests()` there; a test that needs a particular
 * store (a counting store, a database store) installs it with
 * `installTestAppRecordStore(store)` in its own `beforeEach`, which runs after
 * this one; a test of what happens with no store calls
 * `uninstallAppRecordStore()`.
 */
import { beforeEach } from 'vitest'
import { resetTestAppRecordStore } from './memory-record-store'

beforeEach(() => {
  resetTestAppRecordStore()
})
