/**
 * `ConfigOps` over any `FileOps`: decode, validate, and serialize the
 * read-modify-write. What differs per runtime is only how `update` is
 * serialized (a cross-process lock on a host file, or a promise chain) and
 * whether anything has to happen before a read (the local `.env` mode heal),
 * so both implementations are this function with different hooks.
 */
import { ZodError } from 'zod'
import { CONFIG_DOCS, ConfigDocError, configDocMode, type ConfigDoc, type ConfigDocId } from './config-schema'
import type { ConfigOps, FileOps } from './types'

export interface ConfigOpsHooks {
  /** Run `fn` exclusively for this document. The default serializes within this process. */
  serialize?: <T>(id: ConfigDocId, fn: () => Promise<T>) => Promise<T>
  /** Runs before a document is read. */
  beforeGet?: (id: ConfigDocId) => Promise<void>
}

/** Per-document promise chains: an in-process serialization for `update`. */
export function inProcessSerializer(): NonNullable<ConfigOpsHooks['serialize']> {
  const chains = new Map<string, Promise<unknown>>()
  return async (id, fn) => {
    const previous = chains.get(id) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    chains.set(id, run.catch(() => undefined))
    return run
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function createConfigOps(files: FileOps, hooks: ConfigOpsHooks = {}): ConfigOps {
  const serialize = hooks.serialize ?? inProcessSerializer()

  function decode<K extends ConfigDocId>(id: K, bytes: Uint8Array): ConfigDoc<K> {
    const spec = CONFIG_DOCS[id]
    const text = decoder.decode(bytes)
    if (spec.kind === 'text') return text as ConfigDoc<K>
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new ConfigDocError('corrupt', id, 'not valid JSON', { cause: error })
    }
    try {
      return spec.schema.parse(raw) as ConfigDoc<K>
    } catch (error) {
      throw new ConfigDocError('corrupt', id, error instanceof ZodError ? error.message : String(error), { cause: error })
    }
  }

  function encode<K extends ConfigDocId>(id: K, doc: ConfigDoc<K>): Uint8Array {
    const spec = CONFIG_DOCS[id]
    if (spec.kind === 'text') {
      if (typeof doc !== 'string') throw new ConfigDocError('invalid', id, 'expected text')
      return encoder.encode(doc)
    }
    let validated: unknown
    try {
      validated = spec.schema.parse(doc)
    } catch (error) {
      throw new ConfigDocError('invalid', id, error instanceof ZodError ? error.message : String(error), { cause: error })
    }
    return encoder.encode(JSON.stringify(validated, null, 2))
  }

  const get = async <K extends ConfigDocId>(id: K): Promise<ConfigDoc<K> | null> => {
    await hooks.beforeGet?.(id)
    const bytes = await files.getDoc(CONFIG_DOCS[id].path)
    return bytes === null ? null : decode(id, bytes)
  }

  const put = async <K extends ConfigDocId>(id: K, doc: ConfigDoc<K>): Promise<void> => {
    const mode = configDocMode(id)
    await files.putDoc(CONFIG_DOCS[id].path, encode(id, doc), mode === undefined ? undefined : { mode })
  }

  return {
    get,
    put,
    update: (id, mutate) =>
      serialize(id, async () => {
        const current = await get(id)
        const next = await mutate(current)
        // A mutator that hands the current document back (a lookup that found
        // nothing to change, a conflict it reports another way) leaves the
        // file untouched: no rewrite, no mtime bump, no mode reset.
        if (current !== null && Object.is(next, current)) return next
        await put(id, next)
        return next
      }),
  }
}
