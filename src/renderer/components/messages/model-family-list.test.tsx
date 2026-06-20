// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelFamilyList, findCatalogModel, familyDisplayName } from './model-family-list'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { EffortLevel } from '@shared/lib/container/types'

const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STD: EffortLevel[] = ['low', 'medium', 'high']

// Authored oldest→newest within each family, mirroring the real catalogs.
const CATALOG: ModelDefinition[] = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', family: 'opus', icon: 'anthropic', supportedEfforts: ALL },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus', icon: 'anthropic', supportedEfforts: ALL },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', isLatest: true, icon: 'anthropic', supportedEfforts: ALL },
  { id: 'openai/gpt-5.4', label: 'GPT-5.4', family: 'gpt', icon: 'openai', supportedEfforts: STD, supportsWebSearch: false },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', family: 'gpt', isLatest: true, icon: 'openai', supportedEfforts: STD, supportsWebSearch: false },
]

describe('familyDisplayName', () => {
  it('title-cases normal families and upper-cases acronyms', () => {
    expect(familyDisplayName('opus')).toBe('Opus')
    expect(familyDisplayName('sonnet')).toBe('Sonnet')
    expect(familyDisplayName('gpt')).toBe('GPT')
    expect(familyDisplayName('glm')).toBe('GLM')
  })
})

describe('findCatalogModel', () => {
  it('matches an exact concrete id', () => {
    expect(findCatalogModel('claude-opus-4-7', CATALOG)?.id).toBe('claude-opus-4-7')
  })
  it('resolves a bare family alias to that family latest', () => {
    expect(findCatalogModel('opus', CATALOG)?.id).toBe('claude-opus-4-8')
  })
  it('returns undefined for unknown / empty selections', () => {
    expect(findCatalogModel('nope', CATALOG)).toBeUndefined()
    expect(findCatalogModel(undefined, CATALOG)).toBeUndefined()
  })
})

describe('ModelFamilyList', () => {
  it('lists versions newest-first within a family', async () => {
    // Opus owns the selection → auto-expanded. Read the pinned rows in DOM order.
    const { container } = render(<ModelFamilyList catalog={CATALOG} value="opus" onPick={vi.fn()} />)
    await screen.findByTestId('model-pinned-claude-opus-4-8')
    const ids = Array.from(container.querySelectorAll('[data-testid^="model-pinned-"]')).map((el) =>
      el.getAttribute('data-testid'),
    )
    expect(ids).toEqual([
      'model-pinned-claude-opus-4-8',
      'model-pinned-claude-opus-4-7',
      'model-pinned-claude-opus-4-6',
    ])
  })

  it('picks the concrete id of a chosen version', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<ModelFamilyList catalog={CATALOG} value="opus" onPick={onPick} />)
    await user.click(await screen.findByTestId('model-pinned-claude-opus-4-7'))
    expect(onPick).toHaveBeenCalledWith('claude-opus-4-7')
  })

  it('one-click on a family selects its latest and expands, without closing (composer mode)', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const onSelectFamilyLatest = vi.fn()
    // Sonnet is selected, so opus starts collapsed.
    render(
      <ModelFamilyList
        catalog={CATALOG}
        value="claude-sonnet-4-6"
        onPick={onPick}
        onSelectFamilyLatest={onSelectFamilyLatest}
      />,
    )
    expect(screen.queryByTestId('model-pinned-claude-opus-4-8')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('model-family-opus'))
    // selects the family's latest concrete id, and does NOT take the close path
    expect(onSelectFamilyLatest).toHaveBeenCalledWith('claude-opus-4-8')
    expect(onPick).not.toHaveBeenCalled()
    // and expands so the rest are one tap away
    expect(await screen.findByTestId('model-pinned-claude-opus-4-7')).toBeInTheDocument()
  })

  it('without onSelectFamilyLatest a family click only toggles expansion (settings mode)', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<ModelFamilyList catalog={CATALOG} value="claude-sonnet-4-6" onPick={onPick} offerLatest />)
    expect(screen.queryByTestId('model-pinned-claude-opus-4-8')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('model-family-opus'))
    expect(onPick).not.toHaveBeenCalled() // expanding alone doesn't select
    expect(await screen.findByTestId('model-pinned-claude-opus-4-8')).toBeInTheDocument()
  })

  it('renders acronym family headers upper-cased (GPT)', () => {
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={vi.fn()} />)
    expect(screen.getByTestId('model-family-gpt')).toHaveTextContent('GPT')
  })

  it('warns when the selected model lacks web search, and not otherwise', () => {
    const { rerender } = render(<ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} />)
    expect(screen.getByTestId('model-no-websearch-warning')).toBeInTheDocument()

    rerender(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={vi.fn()} />)
    expect(screen.queryByTestId('model-no-websearch-warning')).not.toBeInTheDocument()
  })

  it('offers a "latest" row only when offerLatest is set', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={onPick} offerLatest />)
    await user.click(await screen.findByTestId('model-latest-opus'))
    expect(onPick).toHaveBeenCalledWith('opus') // stores the bare alias (rides upgrades)
  })

  it('omits the "latest" row in composer mode (offerLatest off)', async () => {
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={vi.fn()} />)
    await screen.findByTestId('model-pinned-claude-opus-4-8')
    expect(screen.queryByTestId('model-latest-opus')).not.toBeInTheDocument()
  })
})
