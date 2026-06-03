// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerOptionsPopover } from './composer-options-popover'
import type { ComposerOptionsState } from './composer-options'
import type { ComposerModel } from '@shared/lib/llm-provider'
import type { EffortLevel } from '@shared/lib/container/types'

const MODELS: ComposerModel[] = [
  { family: 'haiku', modelId: 'haiku', label: 'Haiku' },
  { family: 'sonnet', modelId: 'sonnet', label: 'Sonnet' },
  { family: 'opus', modelId: 'opus', label: 'Opus' },
]

interface HarnessProps {
  initialEffort?: EffortLevel
  initialModel?: string
  models?: ComposerModel[]
  onState?: (state: ComposerOptionsState) => void
  disabled?: boolean
}

// Minimal real-state harness — the popover's auto-reset effect and any state
// transitions need a real React state holder to observe correctly.
function Harness({
  initialEffort = 'high',
  initialModel,
  models = MODELS,
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
    composerModels: models,
    toRuntimeOptions: () => ({ effort, ...(model ? { model } : {}) }),
  }
  onState?.(state)
  return <ComposerOptionsPopover state={state} disabled={disabled} />
}

describe('ComposerOptionsPopover', () => {
  it('renders the combined "Model · Effort" label on the trigger', () => {
    render(<Harness initialModel="opus" initialEffort="high" />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus 4.8 · High')
  })

  it('falls back to Sonnet on the trigger when no model is set', () => {
    render(<Harness initialModel={undefined} initialEffort="medium" />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Sonnet 4.6 · Medium')
  })

  it('resolves a pinned model ID to the right family on the trigger', () => {
    // Real settings stores pinned IDs (e.g. "claude-opus-4-7") while
    // composerModels are keyed by alias. The trigger must still display the
    // correct family — otherwise the user sees one model in the UI while the
    // pinned ID gets sent on the wire.
    render(<Harness initialModel="claude-opus-4-7" initialEffort="high" />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus 4.8 · High')
  })

  it('resolves a region-prefixed Bedrock pinned ID to the right family', () => {
    render(<Harness initialModel="us.anthropic.claude-opus-4-6-v1" initialEffort="high" />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus 4.8 · High')
  })

  it('opens the popover and shows both section headers and all model rows', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="sonnet" />)
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(await screen.findByText('Models')).toBeInTheDocument()
    expect(screen.getByText('Effort')).toBeInTheDocument()
    expect(screen.getByTestId('model-option-haiku')).toBeInTheDocument()
    expect(screen.getByTestId('model-option-sonnet')).toBeInTheDocument()
    expect(screen.getByTestId('model-option-opus')).toBeInTheDocument()
  })

  it('selecting a model calls setModel and closes the popover', async () => {
    const user = userEvent.setup()
    const setModel = vi.fn()
    render(
      <ComposerOptionsPopover
        state={{
          effort: 'high',
          setEffort: vi.fn(),
          model: 'sonnet',
          setModel,
          composerModels: MODELS,
          toRuntimeOptions: () => ({ effort: 'high', model: 'sonnet' }),
        }}
      />
    )
    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-option-opus'))
    expect(setModel).toHaveBeenCalledWith('opus')
    expect(screen.queryByText('Models')).not.toBeInTheDocument()
  })

  it('selecting an effort calls setEffort and closes the popover', async () => {
    const user = userEvent.setup()
    const setEffort = vi.fn()
    render(
      <ComposerOptionsPopover
        state={{
          effort: 'high',
          setEffort,
          model: 'opus',
          setModel: vi.fn(),
          composerModels: MODELS,
          toRuntimeOptions: () => ({ effort: 'high', model: 'opus' }),
        }}
      />
    )
    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('effort-option-low'))
    expect(setEffort).toHaveBeenCalledWith('low')
    expect(screen.queryByText('Effort')).not.toBeInTheDocument()
  })

  it('hides Extra High and Max when a non-Opus model is selected', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="sonnet" />)
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(await screen.findByTestId('effort-option-low')).toBeInTheDocument()
    expect(screen.getByTestId('effort-option-medium')).toBeInTheDocument()
    expect(screen.getByTestId('effort-option-high')).toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-xhigh')).not.toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-max')).not.toBeInTheDocument()
  })

  it('shows all five effort rows when Opus is selected', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="opus" />)
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(await screen.findByTestId('effort-option-xhigh')).toBeInTheDocument()
    expect(screen.getByTestId('effort-option-max')).toBeInTheDocument()
  })

  it('auto-resets effort to Medium when switching from Opus+xhigh to Sonnet', async () => {
    const user = userEvent.setup()
    render(<Harness initialModel="opus" initialEffort="xhigh" />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus 4.8 · Extra High')
    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-option-sonnet'))
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Sonnet 4.6 · Medium')
  })

  it('hides the Models section when composerModels is empty', async () => {
    const user = userEvent.setup()
    render(<Harness models={[]} initialModel={undefined} />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('High')
    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(screen.queryByText('Models')).not.toBeInTheDocument()
    expect(await screen.findByText('Effort')).toBeInTheDocument()
  })

  it('respects the disabled prop on the trigger', () => {
    render(<Harness disabled initialModel="opus" />)
    expect(screen.getByTestId('composer-options-trigger')).toBeDisabled()
  })
})
