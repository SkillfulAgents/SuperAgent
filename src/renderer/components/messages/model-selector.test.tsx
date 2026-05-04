// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelSelector } from './model-selector'
import type { ComposerModel } from '@shared/lib/llm-provider'

const OPTIONS: ComposerModel[] = [
  { family: 'haiku', modelId: 'claude-haiku-4-5', label: 'Haiku' },
  { family: 'sonnet', modelId: 'claude-sonnet-4-6', label: 'Sonnet' },
  { family: 'opus', modelId: 'claude-opus-4-7', label: 'Opus' },
]

describe('ModelSelector', () => {
  it('renders the selected option label on the trigger', () => {
    render(<ModelSelector value="claude-opus-4-7" options={OPTIONS} onChange={() => {}} />)
    expect(screen.getByTestId('model-selector-trigger')).toHaveTextContent('Opus')
  })

  it('falls back to Sonnet when value is undefined', () => {
    render(<ModelSelector value={undefined} options={OPTIONS} onChange={() => {}} />)
    expect(screen.getByTestId('model-selector-trigger')).toHaveTextContent('Sonnet')
  })

  it('opens the popover and shows all three families', async () => {
    const user = userEvent.setup()
    render(<ModelSelector value="claude-sonnet-4-6" options={OPTIONS} onChange={() => {}} />)
    await user.click(screen.getByTestId('model-selector-trigger'))
    expect(await screen.findByTestId('model-option-haiku')).toBeInTheDocument()
    expect(screen.getByTestId('model-option-sonnet')).toBeInTheDocument()
    expect(screen.getByTestId('model-option-opus')).toBeInTheDocument()
  })

  it('calls onChange with the picked modelId', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ModelSelector value="claude-sonnet-4-6" options={OPTIONS} onChange={onChange} />)
    await user.click(screen.getByTestId('model-selector-trigger'))
    await user.click(await screen.findByTestId('model-option-opus'))
    expect(onChange).toHaveBeenCalledWith('claude-opus-4-7')
  })

  it('renders nothing when options is empty (non-Anthropic provider)', () => {
    const { container } = render(
      <ModelSelector value={undefined} options={[]} onChange={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('respects disabled prop', () => {
    render(<ModelSelector value="claude-opus-4-7" options={OPTIONS} onChange={() => {}} disabled />)
    expect(screen.getByTestId('model-selector-trigger')).toBeDisabled()
  })
})
