import { ConfigDocError, type ConfigDoc, type ConfigDocId } from './config-schema'
import type { ConfigOps } from './types'

/**
 * Every lost round means another writer's put landed, so the loop ends once
 * the writers do: this only stops one racing a writer that never does.
 */
const MAX_ATTEMPTS = 100

/**
 * Read-modify-write a configuration document as a compare-and-set: `mutate`
 * sees the stored document and is run again when another writer stored one
 * meanwhile, so it must be pure. A mutator that returns null, or the document
 * it was given, writes nothing. Resolves to the document as it stands
 * afterwards, null when there is none.
 */
export async function updateConfigDoc<K extends ConfigDocId>(
  config: ConfigOps,
  id: K,
  mutate: (current: ConfigDoc<K> | null) => ConfigDoc<K> | null | Promise<ConfigDoc<K> | null>,
): Promise<ConfigDoc<K> | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { doc, revision } = await config.read(id)
    const next = await mutate(doc)
    if (next === null || Object.is(next, doc)) return doc
    if (await config.put(id, next, { ifRevision: revision })) return next
  }
  throw new ConfigDocError('conflict', id, `kept changing while it was updated (${MAX_ATTEMPTS} attempts)`)
}
