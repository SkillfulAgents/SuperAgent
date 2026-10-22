import fs from 'fs'
import path from 'path'
import type { KoffiFunc } from 'koffi'
import type { SpotlightDomain, SpotlightItem } from './spotlight-items'

/** Built by scripts/build-macos-bridges.sh from native/macos/SpotlightBridge.swift. */
export const SPOTLIGHT_BRIDGE_FILE = 'libSpotlightBridge.dylib'

/** One batch of writes, applied in order: domain deletes, id deletes, upserts. */
export interface SpotlightChanges {
  deleteDomains?: SpotlightDomain[]
  deleteIds?: string[]
  index?: SpotlightItem[]
}

export interface SpotlightIndex {
  apply(changes: SpotlightChanges): Promise<void>
}

/**
 * The app's Spotlight index, or null when the bridge was never built (a dev
 * checkout without `npm run build:macos-bridges`) or will not load.
 *
 * Loaded into this process on purpose: Spotlight files items under the bundle
 * identifier of the process that indexes them, so a helper binary would index
 * them as someone else.
 */
export async function loadSpotlightIndex(dir: string): Promise<SpotlightIndex | null> {
  const file = path.join(dir, SPOTLIGHT_BRIDGE_FILE)
  if (!fs.existsSync(file)) return null
  let applyNative: KoffiFunc<(changes: string) => string | null>
  try {
    // Imported here rather than at the top: koffi loads its native addon on
    // import and throws when the platform has none, and only macOS has a
    // bridge to call.
    const { load } = await import('koffi')
    // `str!` frees the returned error string after converting it.
    applyNative = load(file).func('str! spotlight_apply(str changes)') as typeof applyNative
  } catch (error) {
    console.error('[Spotlight] Failed to load the bridge:', error)
    return null
  }

  // One call at a time: a batch's domain delete must not overtake the upserts
  // of the batch before it.
  let queue: Promise<void> = Promise.resolve()
  return {
    apply(changes) {
      const run = queue.then(() => new Promise<void>((resolve, reject) => {
        applyNative.async(JSON.stringify(changes), (err: unknown, error) => {
          if (err) reject(err instanceof Error ? err : new Error(String(err)))
          else if (error) reject(new Error(error))
          else resolve()
        })
      }))
      queue = run.catch(() => {})
      return run
    },
  }
}
