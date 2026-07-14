// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerOptionsPopover } from './composer-options-popover'
import type { ComposerOptionsState } from './composer-options'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { EffortLevel } from '@shared/lib/container/types'

const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STD: EffortLevel[] = ['low', 'medium', 'high']

const CATALOG: ModelDefinition[] = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus', icon: 'anthropic', supportedEfforts: ALL },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', isLatest: true, icon: 'anthropic', supportedEfforts: ALL },
]

interface HarnessProps {
  initialEffort?: EffortLevel
  initialModel?: string
  catalog?: ModelDefinition[]
  onState?: (state: ComposerOptionsState) => void
  disabled?: boolean
}

// Minimal real-state harness — the popover's auto-reset effect and any state
// transitions need a real React state holder to observe correctly.
function Harness({
  initialEffort = 'high',
  initialModel,
  catalog = CATALOG,
  onState,
  disabled,
}: HarnessProps) {
  const [effort, setEffort] = useState<EffortLevel>(initialEffort)
  const [model, setModel] = useState<string | undefined>(initialModel)
  const state: ComposerOptionsState = {
    effort,
    setEffort,
    model,
    setModel,
    catalog,
    toRuntimeOptions: () => ({ effort, ...(model ? { model } : {}) }),
  }
  onState?.(state)
  return <ComposerOptionsPopover state={state} disabled={disabled} />
}

describe('ComposerOptionsPopover', () => {
  it('renders the combined "Model · Effort" label, resolving a bare alias to its latest', () => {
    render(<Harness initialModel="opus" initialEffort="high" />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus 4.8 · High')
  })

  it('falls back to Sonnet on the trigger when no model is set', () => {
    render(<Harness initialModel={undefined} initialEffort="medium" />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Sonnet 4.6 · Medium')
  })

  it('displays the exact pinned version (does not collapse to the family latest)', () => {
    render(<Harness initialModel="claude-opus-4-7" initialEffort="high" />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus 4.7 · High')
  })

  it('opens the popover and groups models by family (no per-version flat list)', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="claude-sonnet-4-6" />)
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(await screen.findByText('Models')).toBeInTheDocument()
    expect(screen.getByText('Effort')).toBeInTheDocument()
    // Flat list: concrete versions are top-level rows, no family headers.
    expect(screen.getByTestId('model-pinned-claude-haiku-4-5')).toBeInTheDocument()
    expect(screen.getByTestId('model-pinned-claude-sonnet-4-6')).toBeInTheDocument()
    expect(screen.getByTestId('model-pinned-claude-opus-4-8')).toBeInTheDocument()
    // Composer never offers the bare-alias "latest" row.
    expect(screen.queryByTestId('model-latest-opus')).not.toBeInTheDocument()
  })

  it('picking a version calls setModel with the concrete id and keeps the popover open', async () => {
    const user = userEvent.setup()
    const setModel = vi.fn()
    render(
      <ComposerOptionsPopover
        state={{
          effort: 'high',
          setEffort: vi.fn(),
          model: 'claude-sonnet-4-6',
          setModel,
          catalog: CATALOG,
          toRuntimeOptions: () => ({ effort: 'high', model: 'claude-sonnet-4-6' }),
        }}
      />
    )
    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-pinned-claude-opus-4-8'))
    expect(setModel).toHaveBeenCalledWith('claude-opus-4-8')
    // Stays open so model + effort can be tuned together.
    expect(screen.getByText('Models')).toBeInTheDocument()
  })

  it('selecting an effort calls setEffort and keeps the popover open', async () => {
    const user = userEvent.setup()
    const setEffort = vi.fn()
    render(
      <ComposerOptionsPopover
        state={{
          effort: 'high',
          setEffort,
          model: 'claude-opus-4-8',
          setModel: vi.fn(),
          catalog: CATALOG,
          toRuntimeOptions: () => ({ effort: 'high', model: 'claude-opus-4-8' }),
        }}
      />
    )
    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('effort-option-low'))
    expect(setEffort).toHaveBeenCalledWith('low')
    // The slider stays put so you can keep adjusting model + effort together.
    expect(screen.getByText('Effort')).toBeInTheDocument()
  })

  it('hides Extra High and Max when a non-Opus model is selected', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="claude-sonnet-4-6" />)
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(await screen.findByTestId('effort-option-low')).toBeInTheDocument()
    expect(screen.getByTestId('effort-option-high')).toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-xhigh')).not.toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-max')).not.toBeInTheDocument()
  })

  it('shows all five effort rows when Opus is selected', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="claude-opus-4-8" />)
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(await screen.findByTestId('effort-option-xhigh')).toBeInTheDocument()
    expect(screen.getByTestId('effort-option-max')).toBeInTheDocument()
  })

  it('auto-resets effort to Medium when switching from Opus+xhigh to Sonnet', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="claude-opus-4-8" initialEffort="xhigh" />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus 4.8 · Extra High')
    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-pinned-claude-sonnet-4-6'))
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Sonnet 4.6 · Medium')
  })

  it('hides the Models section when the catalog is empty', async () => {
    const user = userEvent.setup()
    render(<Harness catalog={[]} initialModel={undefined} />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('High')
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(screen.queryByText('Models')).not.toBeInTheDocument()
    expect(await screen.findByText('Effort')).toBeInTheDocument()
  })

  it('respects the disabled prop on the trigger', () => {
    render(<Harness disabled initialModel="claude-opus-4-8" />)
    expect(screen.getByTestId('composer-options-trigger')).toBeDisabled()
  })

  it('orders the sections Model → Effort → Speed', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="claude-opus-4-8" />)
    await user.click(screen.getByTestId('composer-options-trigger'))
    const models = await screen.findByText('Models')
    const effort = screen.getByText('Effort')
    const speed = screen.getByText('Speed')
    // DOM order == visual order (no col-reverse): Models, then Effort, then Speed.
    expect(models.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(effort.compareDocumentPosition(speed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('offers only Normal/Fast speeds for an Anthropic model', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="claude-opus-4-8" />)
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(await screen.findByTestId('speed-option-normal')).toBeInTheDocument()
    expect(screen.getByTestId('speed-option-fast')).toBeInTheDocument()
    expect(screen.queryByTestId('speed-option-slow')).not.toBeInTheDocument()
  })

  it('adds the Slow speed for a GPT (non-Anthropic) model', async () => {
    const user = userEvent.setup()
    const catalog: ModelDefinition[] = [
      ...CATALOG,
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', family: 'gpt', isLatest: true, icon: 'openai', supportedEfforts: STD },
    ]
    render(<Harness catalog={catalog} initialModel="gpt-5.6-sol" />)
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(await screen.findByTestId('speed-option-slow')).toBeInTheDocument()
    expect(screen.getByTestId('speed-option-normal')).toBeInTheDocument()
    expect(screen.getByTestId('speed-option-fast')).toBeInTheDocument()
  })
})
