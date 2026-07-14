// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
      'Beyond about 26% of the context window, requests cost roughly 2× as much. Starting a new session resets this.',
    )
  })

  it('falls back to a token count when the context window is unknown', () => {
    expect(longContextWarningText(cliff)).toBe(
      'Beyond ~272K tokens of context, requests cost roughly 2× as much. Starting a new session resets this.',
    )
  })
})

describe('webToolsWarning', () => {
  it('warns and points to a provider when web tools are unavailable', () => {
    const w = webToolsWarning(true)!
    expect(w).toMatch(/Web search and fetch aren.t available on this model/)
    expect(w).toMatch(/Set a provider under Settings . Web to use them on any model/)
  })

  it('returns null (no banner) when web tools are available', () => {
    expect(webToolsWarning(false)).toBeNull()
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
  it('collapses a lineage family to one row with version pin chips, newest-first', async () => {
    const onPick = vi.fn()
    const user = userEvent.setup()
    const { container } = render(<ModelFamilyList catalog={CATALOG} value="opus" onPick={onPick} />)
    // One row for the whole Opus line…
    const row = screen.getByTestId('model-family-opus')
    expect(row).toHaveTextContent('Opus')
    // …with a chip per version (family prefix stripped), newest-first.
    const ids = Array.from(container.querySelectorAll('[data-testid^="model-pinned-claude-opus"]')).map(
      (el) => el.getAttribute('data-testid'),
    )
    expect(ids).toEqual([
      'model-pinned-claude-opus-4-8',
      'model-pinned-claude-opus-4-7',
      'model-pinned-claude-opus-4-6',
    ])
    expect(screen.getByTestId('model-pinned-claude-opus-4-7')).toHaveTextContent('4.7')
    // Chip pins that concrete version; the row label picks the family latest.
    await user.click(screen.getByTestId('model-pinned-claude-opus-4-7'))
    expect(onPick).toHaveBeenLastCalledWith('claude-opus-4-7')
    await user.click(row)
    expect(onPick).toHaveBeenLastCalledWith('claude-opus-4-8')
    // Clicking the row's empty stretch (not a chip) also picks the latest.
    await user.click(screen.getByTestId('model-family-opus-fill'))
    expect(onPick).toHaveBeenLastCalledWith('claude-opus-4-8')
  })

  it('picks the concrete id of a chosen version directly, no drill-in', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<ModelFamilyList catalog={CATALOG} value="opus" onPick={onPick} />)
    await user.click(await screen.findByTestId('model-pinned-claude-opus-4-7'))
    expect(onPick).toHaveBeenCalledWith('claude-opus-4-7')
  })

  it('shows all vendor models flat at once (Sonnet selected still lists every Opus version)', () => {
    render(<ModelFamilyList catalog={CATALOG} value="claude-sonnet-4-6" onPick={vi.fn()} />)
    // Nothing is collapsed: a different family's versions are present without a click.
    expect(screen.getByTestId('model-pinned-claude-opus-4-8')).toBeInTheDocument()
    expect(screen.getByTestId('model-pinned-claude-sonnet-4-6')).toBeInTheDocument()
  })

  it('collapses non-lineage models sharing a versioned label base (GPT-5.6 tiers) into one chip row', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const platformStyle: ModelDefinition[] = [
      { id: 'gpt-5.4', label: 'GPT-5.4', family: 'gpt', icon: 'openai', supportedEfforts: STD },
      { id: 'gpt-5.5', label: 'GPT-5.5', family: 'gpt', icon: 'openai', supportedEfforts: STD },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', family: 'gpt', icon: 'openai', supportedEfforts: STD },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', family: 'gpt', icon: 'openai', supportedEfforts: STD },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', family: 'gpt', isLatest: true, icon: 'openai', supportedEfforts: STD },
    ]
    render(<ModelFamilyList catalog={platformStyle} value="gpt-5.5" onPick={onPick} />)
    // One row for the 5.6 line, chips per tier (newest-first), suffix-only labels.
    const row = screen.getByTestId('model-family-gpt-5.6')
    expect(row).toHaveTextContent('GPT-5.6')
    expect(screen.getByTestId('model-pinned-gpt-5.6-sol')).toHaveTextContent('Sol')
    expect(screen.getByTestId('model-pinned-gpt-5.6-terra')).toHaveTextContent('Terra')
    expect(screen.getByTestId('model-pinned-gpt-5.6-luna')).toHaveTextContent('Luna')
    // 5.5 and 5.4 stay single rows (their labels carry no variant word).
    expect(screen.getByTestId('model-pinned-gpt-5.5')).toHaveTextContent('GPT-5.5')
    expect(screen.getByTestId('model-pinned-gpt-5.4')).toHaveTextContent('GPT-5.4')
    // Row click picks the line's latest tier; a chip pins a specific one.
    await user.click(row)
    expect(onPick).toHaveBeenLastCalledWith('gpt-5.6-sol')
    await user.click(screen.getByTestId('model-pinned-gpt-5.6-luna'))
    expect(onPick).toHaveBeenLastCalledWith('gpt-5.6-luna')
  })

  it('offers a per-family "latest" alias row in settings mode', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={onPick} offerLatest />)
    await user.click(screen.getByTestId('model-latest-gpt'))
    expect(onPick).toHaveBeenCalledWith('gpt') // stores the bare alias (rides upgrades)
  })

  it('hides vendor tabs when the catalog has a single vendor', () => {
    const claudeOnly = CATALOG.filter((m) => m.icon === 'anthropic')
    render(<ModelFamilyList catalog={claudeOnly} value="claude-opus-4-8" onPick={vi.fn()} />)
    expect(screen.queryByTestId('model-vendor-tab-anthropic')).not.toBeInTheDocument()
  })

  it('vendor tabs are icon-only with the name as accessible label', () => {
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={vi.fn()} />)
    const tab = screen.getByTestId('model-vendor-tab-openai')
    expect(tab).toHaveAccessibleName('OpenAI')
    expect(tab).not.toHaveTextContent(/OpenAI/) // name lives in the tooltip, not the tab
    expect(screen.getByTestId('model-vendor-tab-anthropic')).toHaveAccessibleName('Anthropic')
  })

  it('opens on the selection vendor tab and filters the list to it', () => {
    render(<ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} />)
    expect(screen.getByTestId('model-vendor-tab-openai')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('model-pinned-openai/gpt-5.5')).toBeInTheDocument()
    expect(screen.queryByTestId('model-pinned-claude-opus-4-8')).not.toBeInTheDocument()
  })

  it('switching vendor tab swaps the model list without picking a model', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={onPick} />)
    expect(screen.getByTestId('model-pinned-claude-opus-4-8')).toBeInTheDocument()
    expect(screen.queryByTestId('model-pinned-openai/gpt-5.5')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('model-vendor-tab-openai'))
    expect(screen.getByTestId('model-pinned-openai/gpt-5.5')).toBeInTheDocument()
    expect(screen.queryByTestId('model-pinned-claude-opus-4-8')).not.toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()

    // Round-trip back: the Anthropic models return, selection intact.
    await user.click(screen.getByTestId('model-vendor-tab-anthropic'))
    expect(screen.getByTestId('model-pinned-claude-opus-4-8')).toBeInTheDocument()
  })

  it('warns when a non-Claude model lacks web tools and no vendor is set, and not for Claude', () => {
    const { rerender } = render(<ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} />)
    expect(screen.getByTestId('model-no-websearch-warning')).toHaveTextContent(/search and fetch/)

    rerender(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={vi.fn()} />)
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

  it('notes the long-context price cliff for GPT at the end of the list, and not for flat-priced Claude', () => {
    const { rerender } = render(<ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} />)
    const note = screen.getByTestId('model-long-context-cliff-warning')
    // Plain-language footnote naming the family generation (shared label
    // prefix); mechanics live behind the hover tooltip.
    expect(note).toHaveTextContent('Long chats cost more on GPT-5 models')
    expect(screen.getByTestId('model-long-context-cliff-info')).toBeInTheDocument()

    rerender(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={vi.fn()} />)
    expect(screen.queryByTestId('model-long-context-cliff-warning')).not.toBeInTheDocument()
  })

  it('marks alias semantics with the Latest chip in settings mode, not a "· latest" label suffix', () => {
    // The chip replaced the interim text suffix — the row label must stay bare
    // so the chip is the single latest-vs-pin signal.
    render(<ModelFamilyList catalog={CATALOG} value="opus" onPick={vi.fn()} offerLatest />)
    expect(screen.getByTestId('model-latest-opus')).not.toHaveTextContent('· latest')
    expect(screen.getByTestId('model-latest-chip-opus')).toBeInTheDocument()
  })

  it('hides version chips on touch, where a gear on the selected row opens a nested version menu', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={onPick} />)

    // Chips are display-none whenever ANY coarse pointer exists (has-touch:,
    // any-pointer — not the primary-pointer touch: variant): invisible chips
    // must never be tap targets, and on hybrid touch laptops the primary
    // pointer is a fine mouse while the finger is still there to mis-tap.
    expect(screen.getByTestId('model-pinned-claude-opus-4-7').parentElement!.className).toContain(
      'has-touch:hidden',
    )

    // Only the selected row gets the gear; it's touch-only via CSS.
    expect(screen.queryByTestId('model-family-sonnet-versions')).not.toBeInTheDocument()
    const gear = screen.getByTestId('model-family-opus-versions')
    expect(gear.className).toContain('has-touch:inline-flex')

    // Gear toggles the nested menu: a "· latest" row plus one row per version.
    expect(screen.queryByTestId('model-version-claude-opus-4-7')).not.toBeInTheDocument()
    await user.click(gear)
    expect(screen.getByTestId('model-family-opus-menu-latest')).toHaveTextContent('Opus · latest')
    await user.click(screen.getByTestId('model-version-claude-opus-4-7'))
    expect(onPick).toHaveBeenLastCalledWith('claude-opus-4-7')
    // The latest menu row repeats the row-label action (latest concrete id in
    // composer mode).
    await user.click(screen.getByTestId('model-family-opus-menu-latest'))
    expect(onPick).toHaveBeenLastCalledWith('claude-opus-4-8')
    // …and toggles closed.
    await user.click(gear)
    expect(screen.queryByTestId('model-version-claude-opus-4-7')).not.toBeInTheDocument()
  })

  it('closes the nested version menu when the selection leaves the row', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    // Stateful harness: picking really moves the selection between rows.
    function Harness() {
      const [value, setValue] = useState('claude-opus-4-8')
      return (
        <ModelFamilyList
          catalog={CATALOG}
          value={value}
          onPick={(v) => {
            onPick(v)
            setValue(v)
          }}
        />
      )
    }
    render(<Harness />)
    await user.click(screen.getByTestId('model-family-opus-versions'))
    expect(screen.getByTestId('model-version-claude-opus-4-7')).toBeInTheDocument()

    // Move the selection to Sonnet, then back to Opus: the menu must come back
    // CLOSED — stale-open state would shift the rows mid-interaction.
    await user.click(screen.getByTestId('model-family-sonnet'))
    expect(screen.queryByTestId('model-version-claude-opus-4-7')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('model-family-opus'))
    expect(screen.queryByTestId('model-version-claude-opus-4-7')).not.toBeInTheDocument()
  })

  it('standalone models keep their own brand icon on the row', () => {
    const withStandalone: ModelDefinition[] = [
      ...CATALOG,
      { id: 'local-llama', label: 'Llama 3 8B', icon: 'uploaded:my-provider.png', supportedEfforts: STD },
    ]
    render(<ModelFamilyList catalog={withStandalone} value="claude-opus-4-8" onPick={vi.fn()} />)
    // Uploaded icons pool the model under the "Other" tab, where the row icon
    // is the only thing distinguishing same-named custom-provider models.
    fireEvent.click(screen.getByTestId('model-vendor-tab-other'))
    expect(screen.getByTestId('model-option-local-llama').querySelector('img, svg')).not.toBeNull()
  })

  it('the nested version menu stores the bare alias from its latest row in settings mode', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-7" onPick={onPick} offerLatest />)
    await user.click(screen.getByTestId('model-latest-opus-versions'))
    // The pinned selection's version row carries the check, not the latest row.
    await user.click(screen.getByTestId('model-latest-opus-menu-latest'))
    expect(onPick).toHaveBeenLastCalledWith('opus')
  })

  it('hides the web-tools warning when browsing a tab that does not own the selection', async () => {
    const user = userEvent.setup()
    render(<ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} />)
    expect(screen.getByTestId('model-no-websearch-warning')).toBeInTheDocument()
    // On the Anthropic tab the warning's "this model" copy would read as being
    // about the Claude models on screen — hide it like the cliff note.
    await user.click(screen.getByTestId('model-vendor-tab-anthropic'))
    expect(screen.queryByTestId('model-no-websearch-warning')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('model-vendor-tab-openai'))
    expect(screen.getByTestId('model-no-websearch-warning')).toBeInTheDocument()
  })

  it('hides the cliff note when browsing a tab that does not own the selection', async () => {
    const user = userEvent.setup()
    render(<ModelFamilyList catalog={CATALOG} value="openai/gpt-5.5" onPick={vi.fn()} />)
    expect(screen.getByTestId('model-long-context-cliff-warning')).toBeInTheDocument()
    // Switch to the Anthropic tab — the GPT selection's note would read as
    // being about Claude models, so it hides until you're back on OpenAI.
    await user.click(screen.getByTestId('model-vendor-tab-anthropic'))
    expect(screen.queryByTestId('model-long-context-cliff-warning')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('model-vendor-tab-openai'))
    expect(screen.getByTestId('model-long-context-cliff-warning')).toBeInTheDocument()
  })

  it('shows a Latest chip on lineage rows in settings mode: lit for alias, unlit for pin', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    // Alias selected: Latest chip is the active one, no version chip lit.
    const { rerender } = render(<ModelFamilyList catalog={CATALOG} value="opus" onPick={onPick} offerLatest />)
    const latestChip = screen.getByTestId('model-latest-chip-opus')
    expect(latestChip).toHaveTextContent('Latest')
    expect(latestChip.className).toContain('shadow-sm')
    expect(screen.getByTestId('model-pinned-claude-opus-4-8').className).not.toContain('shadow-sm')
    await user.click(latestChip)
    expect(onPick).toHaveBeenLastCalledWith('opus')

    // Pinned: the version chip is lit instead of Latest.
    rerender(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-7" onPick={onPick} offerLatest />)
    expect(screen.getByTestId('model-latest-chip-opus').className).not.toContain('shadow-sm')
    expect(screen.getByTestId('model-pinned-claude-opus-4-7').className).toContain('shadow-sm')
  })

  it('renders the family alias as a "GPT · Latest" chip row in settings mode, versions unsuffixed', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<ModelFamilyList catalog={CATALOG} value="gpt" onPick={onPick} offerLatest />)
    // Alias row: label + Latest chip, no "· latest" text suffix.
    const aliasRow = screen.getByTestId('model-latest-gpt')
    expect(aliasRow).toHaveTextContent('GPT')
    expect(aliasRow).not.toHaveTextContent('· latest')
    await user.click(screen.getByTestId('model-latest-chip-gpt'))
    expect(onPick).toHaveBeenLastCalledWith('gpt')
    // Version rows drop the "· pinned" suffix; state reads from highlights.
    expect(screen.getByTestId('model-pinned-openai/gpt-5.5')).not.toHaveTextContent('pinned')
  })

  it('omits Latest chips in composer mode (concrete picks only)', () => {
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-4-8" onPick={vi.fn()} />)
    expect(screen.queryByTestId('model-latest-chip-opus')).not.toBeInTheDocument()
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
