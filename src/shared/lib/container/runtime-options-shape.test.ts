import { describe, expect, it, vi } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { chatIntegrations, scheduledTasks, todos, webhookTriggers } from '@shared/lib/db/schema'
import {
  agentDefaultRuntimeOptions,
  fromStoredRuntimeOptions,
  parseRuntimeOptions,
  pickRuntimeOptions,
  RUNTIME_OPTION_KEYS,
  RuntimeOptionsPatchSchema,
  RuntimeOptionsSchema,
  storedRuntimeOptionsUpdate,
} from './runtime-options'

describe('the tables that keep runtime options', () => {
  const COLUMN_OF = { llmProviderId: 'llm_provider_id', model: 'model', effort: 'effort', speed: 'speed' } as const

  it.each([
    ['scheduled_tasks', scheduledTasks],
    ['webhook_triggers', webhookTriggers],
    ['chat_integrations', chatIntegrations],
    ['todos', todos],
  ])('%s has every knob, and drops a pick of a deleted connection', (_name, table) => {
    const columns = getTableConfig(table).columns.map((c) => c.name)
    for (const key of RUNTIME_OPTION_KEYS) expect(columns).toContain(COLUMN_OF[key])
    const connection = getTableConfig(table).foreignKeys.find((fk) => fk.reference().columns[0].name === 'llm_provider_id')
    expect(getTableConfig(connection!.reference().foreignTable).name).toBe('llm_connections')
    expect(connection!.onDelete).toBe('set null')
  })
})

describe('RuntimeOptionsSchema', () => {
  it('is the four knobs and nothing per message', () => {
    expect(Object.keys(RuntimeOptionsSchema.shape).sort()).toEqual([...RUNTIME_OPTION_KEYS].sort())
    expect(RuntimeOptionsSchema.safeParse({ shouldQuery: false }).success).toBe(false)
    expect(parseRuntimeOptions({ model: 'opus', effort: 'high', llmProviderId: null, shouldQuery: false }))
      .toEqual({ model: 'opus', effort: 'high', llmProviderId: null })
  })
})

describe('RuntimeOptionsPatchSchema', () => {
  it('keeps absent knobs absent and null as a clear', () => {
    // The update routes hand the parsed patch on as it is: a key must be there only where the body had one.
    expect(RuntimeOptionsPatchSchema.parse({ effort: 'high', model: null })).toEqual({ effort: 'high', model: null })
    expect(Object.keys(RuntimeOptionsPatchSchema.parse({ speed: 'slow' }))).toEqual(['speed'])
    expect(Object.keys(RuntimeOptionsPatchSchema.parse({}))).toEqual([])
  })

  it('refuses an unknown knob', () => {
    expect(RuntimeOptionsPatchSchema.safeParse({ temperature: 1 }).success).toBe(false)
  })
})

describe('storedRuntimeOptionsUpdate', () => {
  const appDefault = (id: string | undefined) => vi.fn(async () => id)

  it('writes only what the edit names, without asking for the app default', async () => {
    const ask = appDefault('conn-default')
    expect(await storedRuntimeOptionsUpdate({ effort: 'high' }, { llmProviderId: 'conn-1' }, ask)).toEqual({ effort: 'high' })
    expect(await storedRuntimeOptionsUpdate({ speed: null }, { llmProviderId: null }, ask)).toEqual({ speed: null })
    expect(await storedRuntimeOptionsUpdate({}, { llmProviderId: null }, ask)).toEqual({})
    expect(ask).not.toHaveBeenCalled()
  })

  it('clears the connection with the model', async () => {
    const ask = appDefault('conn-default')
    expect(await storedRuntimeOptionsUpdate({ model: null }, { llmProviderId: 'conn-1' }, ask)).toEqual({ model: null, llmProviderId: null })
    expect(await storedRuntimeOptionsUpdate({ model: null, llmProviderId: 'conn-2' }, { llmProviderId: 'conn-1' }, ask)).toEqual({ model: null, llmProviderId: null })
    expect(await storedRuntimeOptionsUpdate({ model: '' }, { llmProviderId: 'conn-1' }, ask)).toEqual({ model: '', llmProviderId: null })
    expect(ask).not.toHaveBeenCalled()
  })

  it('keeps a model picked without a connection on the row\'s connection, else the app default', async () => {
    expect(await storedRuntimeOptionsUpdate({ model: 'sonnet' }, { llmProviderId: 'conn-1' }, appDefault('conn-default'))).toEqual({ model: 'sonnet', llmProviderId: 'conn-1' })
    expect(await storedRuntimeOptionsUpdate({ model: 'sonnet' }, { llmProviderId: null }, appDefault('conn-default'))).toEqual({ model: 'sonnet', llmProviderId: 'conn-default' })
    // No app default (before the legacy import): the connection is left as it is.
    expect(await storedRuntimeOptionsUpdate({ model: 'sonnet' }, { llmProviderId: 'conn-1' }, appDefault(undefined))).toEqual({ model: 'sonnet' })
  })

  it('takes the connection the edit names, null included', async () => {
    const ask = appDefault('conn-default')
    expect(await storedRuntimeOptionsUpdate({ model: 'sonnet', llmProviderId: 'conn-2' }, { llmProviderId: 'conn-1' }, ask)).toEqual({ model: 'sonnet', llmProviderId: 'conn-2' })
    expect(await storedRuntimeOptionsUpdate({ model: 'sonnet', llmProviderId: null }, { llmProviderId: 'conn-1' }, ask)).toEqual({ model: 'sonnet', llmProviderId: null })
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('fromStoredRuntimeOptions', () => {
  it('turns a stored row into runtime options, dropping levels this build does not know', () => {
    expect(fromStoredRuntimeOptions({ llmProviderId: 'conn-1', model: 'opus', effort: 'high', speed: 'warp' }))
      .toEqual({ llmProviderId: 'conn-1', model: 'opus', effort: 'high' })
    expect(fromStoredRuntimeOptions({ llmProviderId: null, model: null, effort: null, speed: 'fast' })).toEqual({ speed: 'fast' })
    expect(fromStoredRuntimeOptions({})).toEqual({})
  })

  it('keeps a model on no connection as such, and drops a connection with no model', () => {
    expect(fromStoredRuntimeOptions({ llmProviderId: null, model: 'opus', effort: null, speed: null })).toEqual({ llmProviderId: null, model: 'opus' })
    expect(fromStoredRuntimeOptions({ llmProviderId: 'conn-1', model: null, effort: null, speed: null })).toEqual({})
  })
})

describe('agentDefaultRuntimeOptions', () => {
  it('renames the preference keys, keeping unset apart from null', () => {
    expect(agentDefaultRuntimeOptions({ defaultModel: 'haiku', defaultEffort: 'low', defaultLlmProviderId: null }))
      .toEqual({ model: 'haiku', effort: 'low', llmProviderId: null, speed: undefined })
    expect(agentDefaultRuntimeOptions({ defaultModel: 'haiku' }).llmProviderId).toBeUndefined()
    expect(agentDefaultRuntimeOptions(undefined)).toEqual({ model: undefined, effort: undefined, speed: undefined, llmProviderId: undefined })
  })
})

describe('pickRuntimeOptions', () => {
  it('takes only the knobs, and only those present', () => {
    expect(pickRuntimeOptions({ id: 's1', name: 'Session', model: 'opus', effort: 'high', llmProviderId: null }))
      .toEqual({ model: 'opus', effort: 'high', llmProviderId: null })
    expect(pickRuntimeOptions({ taskId: 't1', agentSlug: 'a', speed: null, model: undefined })).toEqual({ speed: null })
  })
})
