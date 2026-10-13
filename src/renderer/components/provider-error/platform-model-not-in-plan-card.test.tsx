// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { PLATFORM_CATALOG } from '@shared/lib/llm-provider/builtin-catalogs'
import { isDeniedByPlan } from '@shared/lib/llm-provider/plan-model-policy'

// SUP-1143: the proxy's 403 model_not_in_plan is an upgrade prompt naming the
// model, never a generic error to retry, and it offers to continue the chat on
// a model the plan includes.

const state = vi.hoisted(() => ({
  denied: ['claude-fable-', 'gpt-6-astra'] as string[],
  updatedAt: 0,
  role: 'owner' as string | null,
  refresh: vi.fn(async () => {}),
  openUpgrade: vi.fn(),
  send: vi.fn(async () => ({ queued: false })),
}))

vi.mock('@renderer/hooks/use-platform-plan', () => ({
  usePlatformPlan: () => ({
    plan: { id: 'pro-30', name: 'Pro 30', deniedModels: state.denied },
    excludedLabel: state.denied.length ? 'Claude Fable and GPT Astra' : null,
    isDenied: (model: string) => isDeniedByPlan(state.denied, model),
    updatedAt: state.updatedAt,
    refresh: state.refresh,
  }),
}))
vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: { role: state.role } }) }))
vi.mock('@renderer/context/plan-upgrade-context', () => ({ usePlanUpgrade: () => state.openUpgrade }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ canUseAgent: () => true }) }))
vi.mock('@renderer/hooks/use-sessions', () => ({ useSession: () => ({ data: { llmProviderId: 'platform-conn' } }) }))
vi.mock('@renderer/hooks/use-llm-connections', () => ({
  useLlmConnections: () => ({
    data: { connections: [{ id: 'platform-conn', provider: 'platform', isConfigured: true, catalog: PLATFORM_CATALOG }] },
  }),
}))
vi.mock('@renderer/hooks/use-message-stream', () => ({ useMessageStream: () => ({ isActive: false }) }))
vi.mock('@renderer/hooks/use-messages', () => ({ useSendMessage: () => ({ mutateAsync: state.send, isPending: false }) }))

import { PlatformModelNotInPlanCard } from './platform-model-not-in-plan-card'

const ERROR = 'API Error: 403 {"type":"error","error":{"type":"model_not_in_plan","message":"claude-fable-5-1 is not included in your workspace\'s plan. Upgrade your plan to use it.","model":"claude-fable-5-1"}}'
const SESSION = { sessionId: 's1', agentSlug: 'agent' }

beforeEach(() => {
  state.denied = ['claude-fable-', 'gpt-6-astra']
  state.updatedAt = 0
  state.role = 'owner'
  state.refresh.mockClear()
  state.openUpgrade.mockClear()
  state.send.mockClear()
})

describe('PlatformModelNotInPlanCard', () => {
  it('names the model and the plan, and re-reads the plan', () => {
    render(<PlatformModelNotInPlanCard message={ERROR} session={SESSION} />)
    expect(screen.getByText("Fable 5.1 isn't included in your plan")).toBeInTheDocument()
    expect(screen.getByText('Pro 30 excludes Claude Fable and GPT Astra. Upgrade to use it, or continue with a model your plan includes.')).toBeInTheDocument()
    expect(state.refresh).toHaveBeenCalled()
  })

  it('opens the upgrade flow for the refused model', async () => {
    const user = userEvent.setup()
    render(<PlatformModelNotInPlanCard message={ERROR} session={SESSION} />)
    await user.click(screen.getByTestId('model-not-in-plan-upgrade'))
    expect(state.openUpgrade).toHaveBeenCalledWith({ model: 'claude-fable-5-1' })
  })

  it('continues the chat on the best model the plan allows', async () => {
    const user = userEvent.setup()
    render(<PlatformModelNotInPlanCard message={ERROR} session={SESSION} />)
    await user.click(screen.getByRole('button', { name: 'Continue with Opus 5.5' }))
    expect(state.send).toHaveBeenCalledWith({
      ...SESSION,
      content: 'Continue',
      llmProviderId: 'platform-conn',
      model: 'claude-opus-5-5',
    })
    expect(screen.queryByTestId('model-not-in-plan-card')).not.toBeInTheDocument()
  })

  it('asks members to go through an admin instead of offering an upgrade they cannot make', () => {
    state.role = 'member'
    render(<PlatformModelNotInPlanCard message={ERROR} session={SESSION} />)
    expect(screen.queryByTestId('model-not-in-plan-upgrade')).not.toBeInTheDocument()
    expect(screen.getByText(/Ask a workspace owner or admin to upgrade/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue with Opus 5.5' })).toBeInTheDocument()
  })

  it('offers to continue on the same model once a fresh plan includes it', () => {
    state.denied = []
    state.updatedAt = Date.now() + 1000
    render(<PlatformModelNotInPlanCard message={ERROR} session={SESSION} />)
    expect(screen.getByText('Fable 5.1 is included in your plan now')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(screen.queryByTestId('model-not-in-plan-upgrade')).not.toBeInTheDocument()
  })

  it('keeps the composer: a history row without a session only offers the upgrade', () => {
    render(<PlatformModelNotInPlanCard message={ERROR} live={false} />)
    expect(screen.queryByTestId('model-not-in-plan-continue')).not.toBeInTheDocument()
    expect(state.refresh).not.toHaveBeenCalled()
  })
})
