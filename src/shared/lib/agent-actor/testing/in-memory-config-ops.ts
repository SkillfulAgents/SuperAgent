/**
 * `ConfigOps` over an in-memory workspace: the generic implementation with
 * in-process serialization and nothing to heal.
 */
import { createConfigOps } from '../config-ops'
import type { FileOps, StoreConfigOps } from '../types'

export function createInMemoryConfigOps(files: FileOps): StoreConfigOps {
  return createConfigOps(files)
}
