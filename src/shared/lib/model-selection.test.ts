import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { chatIntegrations, scheduledTasks, todos, webhookTriggers } from '@shared/lib/db/schema'
import {
  agentDefaultSelection,
  fromStoredSelection,
  MODEL_SELECTION_KEYS,
  modelSelectionPatchSchema,
  modelSelectionSchema,
  modelSelectionState,
  pickModelSelection,
  storedSelectionUpdate,
} from './model-selection'

describe('the tables that keep a model selection', () => {
  const COLUMN_OF = { llmProviderId: 'llm_provider_id', model: 'model', effort: 'effort', speed: 'speed' } as const

  it.each([
    ['scheduled_tasks', scheduledTasks],
    ['webhook_triggers', webhookTriggers],
    ['chat_integrations', chatIntegrations],
    ['todos', todos],
  ])('%s has every knob, and drops a pick of a deleted connection', (_name, table) => {
    const config = getTableConfig(table)
    const columns = config.columns.map((c) => c.name)
    for (const key of MODEL_SELECTION_KEYS) expect(columns).toContain(COLUMN_OF[key])
    const connection = config.foreignKeys.find((fk) => fk.reference().columns[0].name === 'llm_provider_id')
    expect(getTableConfig(connection!.reference().foreignTable).name).toBe('llm_connections')
    expect(connection!.onDelete).toBe('set null')
  })
})

describe('modelSelectionSchema', () => {
  it('takes known levels and a trimmed model, and nothing empty', () => {
    expect(modelSelectionSchema.parse({ model: ' claude-opus-5-5 ', effort: 'high', speed: 'fast', llmProviderId: null }))
      .toEqual({ model: 'claude-opus-5-5', effort: 'high', speed: 'fast', llmProviderId: null })
    expect(modelSelectionSchema.safeParse({ model: '' }).success).toBe(false)
    expect(modelSelectionSchema.safeParse({ effort: 'extreme' }).success).toBe(false)
  })
})

describe('modelSelectionPatchSchema', () => {
  it('keeps absent knobs absent and null as a clear', () => {
    expect(modelSelectionPatchSchema.parse({ effort: 'high', model: null })).toEqual({ effort: 'high', model: null })
    expect(Object.keys(modelSelectionPatchSchema.parse({ speed: 'slow' }))).toEqual(['speed'])
  })

  it('refuses an unknown knob', () => {
    expect(modelSelectionPatchSchema.safeParse({ temperature: 1 }).success).toBe(false)
  })
})

describe('storedSelectionUpdate', () => {
  it('writes only what the edit names', () => {
    expect(storedSelectionUpdate({ effort: 'high' }, { llmProviderId: 'conn-1' }, 'conn-default')).toEqual({ effort: 'high' })
    expect(storedSelectionUpdate({ speed: null }, { llmProviderId: null }, undefined)).toEqual({ speed: null })
  })

  it('clears the connection with the model', () => {
    expect(storedSelectionUpdate({ model: null }, { llmProviderId: 'conn-1' }, 'conn-default')).toEqual({ model: null, llmProviderId: null })
  })

  it('keeps a model picked without a connection on the row\'s connection, else the app default', () => {
    expect(storedSelectionUpdate({ model: 'sonnet' }, { llmProviderId: 'conn-1' }, 'conn-default')).toEqual({ model: 'sonnet', llmProviderId: 'conn-1' })
    expect(storedSelectionUpdate({ model: 'sonnet' }, { llmProviderId: null }, 'conn-default')).toEqual({ model: 'sonnet', llmProviderId: 'conn-default' })
    expect(storedSelectionUpdate({ model: 'sonnet' }, { llmProviderId: null }, undefined)).toEqual({ model: 'sonnet' })
  })

  it('takes the connection the edit names', () => {
    expect(storedSelectionUpdate({ model: 'sonnet', llmProviderId: 'conn-2' }, { llmProviderId: 'conn-1' }, 'conn-default'))
      .toEqual({ model: 'sonnet', llmProviderId: 'conn-2' })
  })
})

describe('fromStoredSelection', () => {
  it('turns a stored row into a selection, dropping levels this build does not know', () => {
    expect(fromStoredSelection({ llmProviderId: 'conn-1', model: 'opus', effort: 'high', speed: 'warp' }))
      .toEqual({ llmProviderId: 'conn-1', model: 'opus', effort: 'high' })
  })

  it('keeps a model on no connection as such, and drops a connection with no model', () => {
    expect(fromStoredSelection({ llmProviderId: null, model: 'opus', effort: null, speed: null })).toEqual({ llmProviderId: null, model: 'opus' })
    expect(fromStoredSelection({ llmProviderId: 'conn-1', model: null, effort: null, speed: null })).toEqual({})
  })
})

describe('agentDefaultSelection', () => {
  it('renames the preference keys, keeping unset apart from null', () => {
    expect(agentDefaultSelection({ defaultModel: 'haiku', defaultEffort: 'low', defaultLlmProviderId: null }))
      .toEqual({ model: 'haiku', effort: 'low', llmProviderId: null, speed: undefined })
    expect(agentDefaultSelection({ defaultModel: 'haiku' }).llmProviderId).toBeUndefined()
    expect(agentDefaultSelection(undefined)).toEqual({ model: undefined, effort: undefined, speed: undefined, llmProviderId: undefined })
  })
})

describe('pickModelSelection', () => {
  it('takes only the knobs, and only those present', () => {
    expect(pickModelSelection({ id: 's1', name: 'Session', model: 'opus', effort: 'high', llmProviderId: null }))
      .toEqual({ model: 'opus', effort: 'high', llmProviderId: null })
    expect(pickModelSelection({ taskId: 't1', agentSlug: 'a', speed: null })).toEqual({ speed: null })
  })
})

describe('modelSelectionState', () => {
  it('has every knob, null where nothing was picked', () => {
    expect(modelSelectionState({ effort: 'max' })).toEqual({ llmProviderId: null, model: null, effort: 'max', speed: null })
  })
})
