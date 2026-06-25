/**
 * Persistent instanceId → Browserbase contextId map shared by the Browserbase
 * and platform host-browser providers.
 *
 * Hardened for SUP-315: the map is a single JSON file read-modify-written from
 * concurrent `getOrCreateContext` calls (which `await` a network create between
 * read and write). The old code read with a swallow-to-`{}` catch and wrote
 * non-atomically, so a transient bad read or two instances racing wiped every
 * other agent's persistent context — and leaked the now-orphaned (billable)
 * Browserbase contexts. This store reads fail-closed, writes atomically, and
 * serializes the upsert under a per-file lock.
 */
import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import {
  readJsonFileStrictSync,
  writeJsonFileAtomicSync,
  withFileLock,
} from '@shared/lib/utils/file-storage'

const contextMapSchema = z.record(z.string(), z.string())

export type ContextMap = Record<string, string>

/**
 * Read the map. Fail-closed: absent file → `{}`, but a corrupt/torn file or IO
 * error THROWS (so a transiently-unreadable file can't be silently treated as
 * empty and then overwritten, wiping/leaking every other agent's context).
 */
export function loadContextMap(filePath: string): ContextMap {
  return readJsonFileStrictSync(filePath, contextMapSchema, {})
}

/** Atomic (temp-file + rename) overwrite of the whole map. */
export function saveContextMap(filePath: string, map: ContextMap): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  writeJsonFileAtomicSync(filePath, map)
}

/**
 * Serialized + atomic upsert of a single `key → contextId` mapping. Re-reads
 * the map fresh under the lock (so a mapping created concurrently for a
 * different key survives) and writes atomically.
 */
export async function setContextMapping(filePath: string, key: string, contextId: string): Promise<void> {
  await withFileLock(filePath, async () => {
    const map = loadContextMap(filePath)
    map[key] = contextId
    saveContextMap(filePath, map)
  })
}
