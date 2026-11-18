import { describe, expect, it } from 'vitest'
import type { CatalogOverrideEntry } from './model-catalog-schema'
import { mergeInstalledModels, ollamaModelDefinition } from './ollama-catalog'
import type { InstalledModel } from './server-status-schema'

const installed = (id: string, extra: Partial<InstalledModel> = {}): InstalledModel => ({
  id,
  label: id.replace(/:latest$/, ''),
  supportsThinking: true,
  supportsImageInput: false,
  ...extra,
})

describe('ollamaModelDefinition', () => {
  it('declares what the server reported and no price', () => {
    expect(ollamaModelDefinition(installed('qwen3.8:latest', { contextWindow: 262144, supportsImageInput: true }))).toEqual({
      id: 'qwen3.8:latest',
      label: 'qwen3.8',
      icon: 'ollama',
      supportedEfforts: ['low', 'medium', 'high'],
      supportsWebSearch: false,
      supportsImageInput: true,
      contextWindow: 262144,
    })
  })

  it('offers no effort choice to a model that cannot think', () => {
    expect(ollamaModelDefinition(installed('tiny:latest', { supportsThinking: false })).supportedEfforts).toEqual(['medium'])
  })
})

describe('mergeInstalledModels', () => {
  const a = installed('a:latest')
  const b = installed('b:latest')

  it('adds every runnable model and skips the rest', () => {
    const next = mergeInstalledModels([], [a, installed('embed:latest', { unusableReason: 'embedding-only' }), installed('old:latest', { unusableReason: 'no-tools' })], { remove: true })
    expect(next.map(entry => entry.id)).toEqual(['a:latest'])
  })

  it('keeps a model the person switched off switched off', () => {
    const overrides: CatalogOverrideEntry[] = [{ ...ollamaModelDefinition(a), disabled: true }]
    expect(mergeInstalledModels(overrides, [a, b], { remove: true })).toEqual([
      { ...ollamaModelDefinition(a), disabled: true },
      ollamaModelDefinition(b),
    ])
  })

  it('refreshes what changed about a model it already lists', () => {
    const overrides: CatalogOverrideEntry[] = [ollamaModelDefinition(installed('a:latest', { contextWindow: 262144 }))]
    const next = mergeInstalledModels(overrides, [installed('a:latest', { contextWindow: 8192 })], { remove: true })
    expect(next[0].contextWindow).toBe(8192)
  })

  it('drops an uninstalled model only when asked, except those held on to', () => {
    const overrides = [ollamaModelDefinition(a), ollamaModelDefinition(b)]
    expect(mergeInstalledModels(overrides, [], { remove: false })).toBe(overrides)
    expect(mergeInstalledModels(overrides, [], { remove: true })).toEqual([])
    expect(mergeInstalledModels(overrides, [], { remove: true, keep: new Set(['b:latest']) }).map(entry => entry.id)).toEqual(['b:latest'])
  })

  it('returns the same array when nothing changed, so a poll writes nothing', () => {
    const overrides = [ollamaModelDefinition(a)]
    expect(mergeInstalledModels(overrides, [a], { remove: true })).toBe(overrides)
  })
})
