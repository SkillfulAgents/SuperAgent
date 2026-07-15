// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModelEffortMenu } from './quick-dispatch-menus'
import type { ComposerOptionsState } from '@renderer/components/messages/composer-options'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { EffortLevel } from '@shared/lib/container/types'

const STD: EffortLevel[] = ['low', 'medium', 'high']

const CATALOG: ModelDefinition[] = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', family: 'gpt', isLatest: true, icon: 'openai', supportedEfforts: STD, supportsWebSearch: false, supportedSpeeds: ['slow', 'normal', 'fast'] },
  // Custom models can declare effort subsets that exclude medium.
  { id: 'custom/tiny', label: 'Tiny', isLatest: true, supportedEfforts: ['low'] },
]

function makeState(overrides: Partial<ComposerOptionsState>): ComposerOptionsState {
  return {
    effort: 'medium',
    setEffort: vi.fn(),
    speed: 'normal',
    setSpeed: vi.fn(),
    model: 'claude-sonnet-4-6',
    setModel: vi.fn(),
    catalog: CATALOG,
    toRuntimeOptions: () => ({}),
    ...overrides,
  }
}

describe('ModelEffortMenu', () => {
  it('clamps an effort the selected model does not support back to medium', () => {
    // Regression: this menu once had no clamp (unlike the composer popover and
    // settings select), so Opus @ Max followed by a 3-effort model kept
    // dispatching 'max' while the slider silently rendered at Low.
    const setEffort = vi.fn()
    render(<ModelEffortMenu state={makeState({ effort: 'max', setEffort })} maxHeight={400} />)
    expect(setEffort).toHaveBeenCalledWith('medium')
  })

  it('leaves a supported effort alone', () => {
    const setEffort = vi.fn()
    render(<ModelEffortMenu state={makeState({ effort: 'high', setEffort })} maxHeight={400} />)
    expect(setEffort).not.toHaveBeenCalled()
  })

  it('clamps to the model\'s first allowed level when it does not support medium', () => {
    // Regression: the clamp once hardcoded 'medium', which a custom model with
    // supportedEfforts ['low'] doesn't allow — the "clamped" value would still
    // dispatch an unsupported effort to the provider.
    const setEffort = vi.fn()
    render(<ModelEffortMenu state={makeState({ model: 'custom/tiny', effort: 'high', setEffort })} maxHeight={400} />)
    expect(setEffort).toHaveBeenCalledWith('low')
  })

  it('shows the web-tools warning for a searchless model when no web vendor is set', () => {
    render(<ModelEffortMenu state={makeState({ model: 'openai/gpt-5.5' })} maxHeight={400} />)
    expect(screen.getByTestId('model-no-websearch-warning')).toBeInTheDocument()
  })

  it('passes webProvider through, silencing the warning when a vendor covers all models', () => {
    // Regression: this menu once dropped webProvider, contradicting the
    // composer popover for users with a configured web vendor.
    render(
      <ModelEffortMenu state={makeState({ model: 'openai/gpt-5.5', webProvider: 'exa' })} maxHeight={400} />
    )
    expect(screen.queryByTestId('model-no-websearch-warning')).not.toBeInTheDocument()
  })

  it('shows the catalog-declared speeds for a speed-capable model', () => {
    render(<ModelEffortMenu state={makeState({ model: 'openai/gpt-5.5' })} maxHeight={400} />)
    expect(screen.getByTestId('speed-option-slow')).toBeInTheDocument()
    expect(screen.getByTestId('speed-option-normal')).toBeInTheDocument()
    expect(screen.getByTestId('speed-option-fast')).toBeInTheDocument()
  })

  it('hides the speed section for a model with no declared speeds (normal-only)', () => {
    render(<ModelEffortMenu state={makeState({ model: 'claude-sonnet-4-6' })} maxHeight={400} />)
    expect(screen.queryByText('Speed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('speed-option-normal')).not.toBeInTheDocument()
  })

  it('picking a speed forwards it to setSpeed (dispatch payload rides toRuntimeOptions)', () => {
    const setSpeed = vi.fn()
    render(<ModelEffortMenu state={makeState({ model: 'openai/gpt-5.5', setSpeed })} maxHeight={400} />)
    fireEvent.click(screen.getByTestId('speed-option-fast'))
    expect(setSpeed).toHaveBeenCalledWith('fast')
  })

  it('clamps a speed the selected model does not support back to normal', () => {
    // Parity with the composer popover: without the clamp this menu would keep
    // (and dispatch) a stale 'fast' after switching to a normal-only model,
    // with the section hidden so there'd be no way to see or fix it.
    const setSpeed = vi.fn()
    render(<ModelEffortMenu state={makeState({ model: 'claude-sonnet-4-6', speed: 'fast', setSpeed })} maxHeight={400} />)
    expect(setSpeed).toHaveBeenCalledWith('normal')
  })

  it('leaves a supported speed alone', () => {
    const setSpeed = vi.fn()
    render(<ModelEffortMenu state={makeState({ model: 'openai/gpt-5.5', speed: 'fast', setSpeed })} maxHeight={400} />)
    expect(setSpeed).not.toHaveBeenCalled()
  })
})
