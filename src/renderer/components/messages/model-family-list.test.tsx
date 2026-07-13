// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ModelFamilyList,
  findCatalogModel,
  familyDisplayName,
  formatTokenThreshold,
  longContextWarningText,
  webToolsWarning,
} from './model-family-list'
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
  { id: 'openai/gpt-5.4', label: 'GPT-5.4', family: 'gpt', icon: 'openai', supportedEfforts: STD, supportsWebSearch: false, contextWindow: 1_050_000, longContextPriceCliff: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', family: 'gpt', isLatest: true, icon: 'openai', supportedEfforts: STD, supportsWebSearch: false, contextWindow: 1_050_000, longContextPriceCliff: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
]

describe('familyDisplayName', () => {
  it('title-cases normal families and upper-cases acronyms', () => {
    expect(familyDisplayName('opus')).toBe('Opus')
    expect(familyDisplayName('sonnet')).toBe('Sonnet')
    expect(familyDisplayName('gpt')).toBe('GPT')
    expect(familyDisplayName('glm')).toBe('GLM')
  })
})

describe('formatTokenThreshold', () => {
  it('formats thousands and millions compactly', () => {
    expect(formatTokenThreshold(272_000)).toBe('272K')
    expect(formatTokenThreshold(1_050_000)).toBe('1.05M')
    expect(formatTokenThreshold(500)).toBe('500')
  })
})

describe('longContextWarningText', () => {
  const cliff = { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }

  it('frames the threshold as a share of the context window when known', () => {
    expect(longContextWarningText(cliff, 1_050_000)).toBe(
      'Note: beyond about 26% of the context window, input pricing rises 2× and output 1.5×.',
    )
  })

  it('falls back to a token count when the context window is unknown', () => {
    expect(longContextWarningText(cliff)).toBe(
      'Note: beyond ~272K tokens of context, input pricing rises 2× and output 1.5×.',
    )
  })
})

describe('webToolsWarning', () => {
  it('warns for both when supportsWebSearch is false and no vendor is set', () => {
    const w = webToolsWarning(CATALOG.find((m) => m.id === 'openai/gpt-5.5'), false)!
    expect(w).toMatch(/Web search and fetch aren.t available on this model/)
    expect(w).toMatch(/Set a provider under Settings . Web to use them on any model/)
  })

  it('warns fetch-only when search works but native fetch does not', () => {
    const w = webToolsWarning(
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        supportedEfforts: STD,
        supportsWebSearch: true,
        supportsWebFetch: false,
      },
      false,
    )!
    expect(w).toMatch(/Native web fetch isn.t available/)
    expect(w).toMatch(/search still works/)
  })

  it('returns null for Claude, when both are supported, or when a vendor is set', () => {
    expect(webToolsWarning(CATALOG.find((m) => m.id === 'claude-sonnet-4-6'), false)).toBeNull()
    expect(
      webToolsWarning(
        {
          id: 'gpt-5.5',
          label: 'GPT-5.5',
          supportedEfforts: STD,
          supportsWebSearch: true,
          supportsWebFetch: true,
        },
        false,
      ),
    ).toBeNull()
    expect(webToolsWarning(CATALOG.find((m) => m.id === 'openai/gpt-5.5'), true)).toBeNull()
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
    // selects the family's latest concrete id (family alias alongside, for
    // callers that store "latest" as the bare alias), and does NOT take the close path
    expect(onSelectFamilyLatest).toHaveBeenCalledWith('claude-opus-4-8', 'opus')
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

  it('warns when a non-Claude model lacks web tools and no vendor is set, and not for Claude', () => {
    const { rerender } = render(<ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} />)
    expect(screen.getByTestId('model-no-websearch-warning')).toHaveTextContent(/search and fetch/)

    rerender(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={vi.fn()} />)
    expect(screen.queryByTestId('model-no-websearch-warning')).not.toBeInTheDocument()
  })

  it('warns fetch-only for Platform Responses models (search works, native fetch does not)', () => {
    const platformCatalog: ModelDefinition[] = [
      {
        id: 'grok-4.5',
        label: 'Grok 4.5',
        family: 'grok',
        isLatest: true,
        icon: 'xai',
        supportedEfforts: STD,
        supportsWebSearch: true,
        supportsWebFetch: false,
        contextWindow: 500_000,
      },
    ]
    const { rerender } = render(
      <ModelFamilyList catalog={platformCatalog} value="grok-4.5" onPick={vi.fn()} />,
    )
    expect(screen.getByTestId('model-no-websearch-warning')).toHaveTextContent(/Native web fetch/)
    expect(screen.getByTestId('model-no-websearch-warning')).toHaveTextContent(/search still works/)

    rerender(
      <ModelFamilyList catalog={platformCatalog} value="grok-4.5" onPick={vi.fn()} webProvider="exa" />,
    )
    expect(screen.queryByTestId('model-no-websearch-warning')).not.toBeInTheDocument()
  })

  it('clears the warning on a non-Claude model when a web vendor is configured', () => {
    render(
      <ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} webProvider="exa" />,
    )
    expect(screen.queryByTestId('model-no-websearch-warning')).not.toBeInTheDocument()
  })

  it('treats a "native" provider id as no vendor (still warns)', () => {
    render(
      <ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} webProvider="native" />,
    )
    expect(screen.getByTestId('model-no-websearch-warning')).toBeInTheDocument()
  })

  it('warns about the long-context price cliff for GPT, and not for flat-priced Claude', () => {
    const { rerender } = render(<ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} />)
    const warning = screen.getByTestId('model-long-context-cliff-warning')
    // 272K / 1.05M ≈ 26% of the context window; input/output multipliers spelled out.
    expect(warning).toHaveTextContent('26% of the context window')
    expect(warning).toHaveTextContent('input pricing rises 2× and output 1.5×')

    rerender(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={vi.fn()} />)
    expect(screen.queryByTestId('model-long-context-cliff-warning')).not.toBeInTheDocument()
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
