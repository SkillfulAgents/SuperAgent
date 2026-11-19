import { isDeepStrictEqual } from 'node:util'
import type { SessionMetadata } from '@shared/lib/types/agent'

/**
 * Whether every value in `updates` is already in `entry`, i.e. merging them
 * would store nothing new. An absent key and an `undefined` value are the same
 * entry on disk (JSON drops it); `null` is a value of its own.
 */
export function sessionMetadataHolds(
  entry: SessionMetadata | null | undefined,
  updates: Partial<SessionMetadata>
): boolean {
  return Object.entries(updates).every(([key, value]) =>
    isDeepStrictEqual(entry?.[key as keyof SessionMetadata], value)
  )
}
