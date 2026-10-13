// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ModelFamilyList, type PlanLock } from './model-family-list'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { EffortLevel } from '@shared/lib/container/types'

// SUP-1143: models the workspace's plan excludes stay listed (so users find
// what an upgrade unlocks) but greyed, and picking one opens the upgrade flow.

const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const CATALOG: ModelDefinition[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus', isLatest: true, isDefault: true, icon: 'anthropic', supportedEfforts: ALL },
  { id: 'claude-fable-5', label: 'Fable 5', family: 'fable', icon: 'anthropic', supportedEfforts: ALL },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable', isLatest: true, icon: 'anthropic', supportedEfforts: ALL },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', family: 'gpt-astra', isLatest: true, isDefault: true, icon: 'openai', supportedEfforts: ALL },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', family: 'gpt-sol', isLatest: true, icon: 'openai', supportedEfforts: ALL },
]

function pro30Lock() {
  return {
    isLocked: (m: ModelDefinition) => m.id.startsWith('claude-fable-') || m.id.startsWith('gpt-6-astra'),
    onLockedPick: vi.fn<PlanLock['onLockedPick']>(),
    planName: 'Pro 30',
  } satisfies PlanLock
}

describe('ModelFamilyList plan lock', () => {
  it('lists an excluded family greyed and badged, and its pick opens the upgrade flow instead', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const lock = pro30Lock()
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-5-5" onPick={onPick} planLock={lock} />)

    const fable = screen.getByTestId('model-family-fable')
    expect(fable).toHaveAttribute('data-locked', 'true')
    expect(screen.getByTestId('model-family-opus')).not.toHaveAttribute('data-locked')
    expect(screen.getByText('Upgrade')).toBeInTheDocument()

    await user.click(fable)
    expect(onPick).not.toHaveBeenCalled()
    expect(lock.onLockedPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-fable-5-1' }))
  })

  it('routes a locked version chip to the upgrade flow, and allowed picks still select', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const lock = pro30Lock()
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-5-5" onPick={onPick} planLock={lock} />)

    await user.click(screen.getByTestId('model-pinned-claude-fable-5'))
    expect(lock.onLockedPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-fable-5' }))
    expect(onPick).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('model-family-opus'))
    expect(onPick).toHaveBeenCalledWith('claude-opus-5-5')
  })

  it('never stores a locked family\'s alias from the Latest chip on settings surfaces', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const lock = pro30Lock()
    render(<ModelFamilyList catalog={CATALOG} value="opus" onPick={onPick} planLock={lock} offerLatest />)

    await user.click(screen.getByTestId('model-latest-chip-fable'))
    expect(onPick).not.toHaveBeenCalled()
    expect(lock.onLockedPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-fable-5-1' }))
  })

  it('warns under a saved selection the plan now excludes, with a way to upgrade', async () => {
    const user = userEvent.setup()
    const lock = pro30Lock()
    render(<ModelFamilyList catalog={CATALOG} value="fable" onPick={vi.fn()} planLock={lock} offerLatest />)

    const warning = screen.getByTestId('model-not-in-plan-warning')
    expect(warning).toHaveTextContent("Fable 5.1 isn't included in your Pro 30 plan. Pick another model, or upgrade.")
    await user.click(screen.getByRole('button', { name: 'upgrade' }))
    expect(lock.onLockedPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-fable-5-1' }))
  })

  it('does not pick a vendor\'s locked default when switching tabs', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const lock = pro30Lock()
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-5-5" onPick={onPick} planLock={lock} />)

    await user.click(screen.getByTestId('model-vendor-tab-openai'))
    expect(onPick).not.toHaveBeenCalled()
    expect(lock.onLockedPick).not.toHaveBeenCalled()
    // The tab switched: OpenAI's rows are listed, Astra locked and Sol pickable.
    expect(screen.getByTestId('model-family-gpt-astra')).toHaveAttribute('data-locked', 'true')
    await user.click(screen.getByTestId('model-family-gpt-sol'))
    expect(onPick).toHaveBeenCalledWith('gpt-6.1-sol')
  })

  it('locks nothing without a plan lock', () => {
    render(<ModelFamilyList catalog={CATALOG} value="claude-opus-5-5" onPick={vi.fn()} />)
    expect(screen.getByTestId('model-family-fable')).not.toHaveAttribute('data-locked')
    expect(screen.queryByText('Upgrade')).not.toBeInTheDocument()
  })
})
