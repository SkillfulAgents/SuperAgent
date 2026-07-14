// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ModelEffortMenu } from './quick-dispatch-menus'
import type { ComposerOptionsState } from '@renderer/components/messages/composer-options'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { EffortLevel } from '@shared/lib/container/types'

const STD: EffortLevel[] = ['low', 'medium', 'high']

const CATALOG: ModelDefinition[] = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', family: 'gpt', isLatest: true, icon: 'openai', supportedEfforts: STD, supportsWebSearch: false },
]

function makeState(overrides: Partial<ComposerOptionsState>): ComposerOptionsState {
  return {
    effort: 'medium',
    setEffort: vi.fn(),
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
})
