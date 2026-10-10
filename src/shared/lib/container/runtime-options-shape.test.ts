import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { chatIntegrations, scheduledTasks, todos, webhookTriggers } from '@shared/lib/db/schema'
import {
  agentDefaultRuntimeOptions,
  fromStoredRuntimeOptions,
  RUNTIME_OPTION_KEYS,
  RuntimeOptionsPatchSchema,
  RuntimeOptionsSchema,
  runtimeOptionsState,
  pickRuntimeOptions,
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
    const config = getTableConfig(table)
    const columns = config.columns.map((c) => c.name)
    for (const key of RUNTIME_OPTION_KEYS) expect(columns).toContain(COLUMN_OF[key])
    const connection = config.foreignKeys.find((fk) => fk.reference().columns[0].name === 'llm_provider_id')
    expect(getTableConfig(connection!.reference().foreignTable).name).toBe('llm_connections')
    expect(connection!.onDelete).toBe('set null')
  })
})

describe('RuntimeOptionsSchema', () => {
  it('takes known levels and a trimmed model, and nothing empty', () => {
    expect(RuntimeOptionsSchema.parse({ model: ' claude-opus-5-5 ', effort: 'high', speed: 'fast', llmProviderId: null }))
      .toEqual({ model: 'claude-opus-5-5', effort: 'high', speed: 'fast', llmProviderId: null })
    expect(RuntimeOptionsSchema.safeParse({ model: '' }).success).toBe(false)
    expect(RuntimeOptionsSchema.safeParse({ effort: 'extreme' }).success).toBe(false)
  })
})

describe('RuntimeOptionsPatchSchema', () => {
  it('keeps absent knobs absent and null as a clear', () => {
    expect(RuntimeOptionsPatchSchema.parse({ effort: 'high', model: null })).toEqual({ effort: 'high', model: null })
    expect(Object.keys(RuntimeOptionsPatchSchema.parse({ speed: 'slow' }))).toEqual(['speed'])
  })

  it('refuses an unknown knob', () => {
    expect(RuntimeOptionsPatchSchema.safeParse({ temperature: 1 }).success).toBe(false)
  })
})

describe('storedRuntimeOptionsUpdate', () => {
  it('writes only what the edit names', () => {
    expect(storedRuntimeOptionsUpdate({ effort: 'high' }, { llmProviderId: 'conn-1' }, 'conn-default')).toEqual({ effort: 'high' })
    expect(storedRuntimeOptionsUpdate({ speed: null }, { llmProviderId: null }, undefined)).toEqual({ speed: null })
  })

  it('clears the connection with the model', () => {
    expect(storedRuntimeOptionsUpdate({ model: null }, { llmProviderId: 'conn-1' }, 'conn-default')).toEqual({ model: null, llmProviderId: null })
  })

  it('keeps a model picked without a connection on the row\'s connection, else the app default', () => {
    expect(storedRuntimeOptionsUpdate({ model: 'sonnet' }, { llmProviderId: 'conn-1' }, 'conn-default')).toEqual({ model: 'sonnet', llmProviderId: 'conn-1' })
    expect(storedRuntimeOptionsUpdate({ model: 'sonnet' }, { llmProviderId: null }, 'conn-default')).toEqual({ model: 'sonnet', llmProviderId: 'conn-default' })
    expect(storedRuntimeOptionsUpdate({ model: 'sonnet' }, { llmProviderId: null }, undefined)).toEqual({ model: 'sonnet' })
  })

  it('takes the connection the edit names', () => {
    expect(storedRuntimeOptionsUpdate({ model: 'sonnet', llmProviderId: 'conn-2' }, { llmProviderId: 'conn-1' }, 'conn-default'))
      .toEqual({ model: 'sonnet', llmProviderId: 'conn-2' })
  })
})

describe('fromStoredRuntimeOptions', () => {
  it('turns a stored row into runtime options, dropping levels this build does not know', () => {
    expect(fromStoredRuntimeOptions({ llmProviderId: 'conn-1', model: 'opus', effort: 'high', speed: 'warp' }))
      .toEqual({ llmProviderId: 'conn-1', model: 'opus', effort: 'high' })
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
    expect(pickRuntimeOptions({ taskId: 't1', agentSlug: 'a', speed: null })).toEqual({ speed: null })
  })
})

describe('runtimeOptionsState', () => {
  it('has every knob, null where nothing was picked', () => {
    expect(runtimeOptionsState({ effort: 'max' })).toEqual({ llmProviderId: null, model: null, effort: 'max', speed: null })
  })
})
