// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScopePolicyEditor } from './scope-policy-editor'
import { renderWithProviders, screen, waitFor, within } from '@renderer/test/test-utils'

// Route apiFetch: GET returns the configured policies fixture; PUT captures its body.
let policiesFixture: Array<{ scope: string; decision: string }> = []
let lastPutBody: { policies: Array<{ scope: string; decision: string }> } | null = null

const mockApiFetch = vi.fn((url: string, opts?: { method?: string; body?: string }) => {
  if (opts?.method === 'PUT') {
    lastPutBody = JSON.parse(opts.body as string)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ policies: policiesFixture }) })
})
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...(args as [string, never])),
}))

// Group headers use the dropdown variant: the trigger reports the current
// decision via data-decision; picking a value goes through the portal menu.
const groupDecision = (group: string) =>
  within(screen.getByTestId(`group-default-${group}`)).getByTestId('policy-dropdown-trigger')

const setGroupDecision = async (group: string, decision: 'allow' | 'review' | 'block' | 'default') => {
  groupDecision(group).click()
  const item = await screen.findByTestId(`policy-menu-${decision}`)
  item.click()
}

describe('ScopePolicyEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    policiesFixture = []
    lastPutBody = null
  })

  it('pre-fills the recommended baseline for an untouched account', async () => {
    policiesFixture = [] // no saved policies → untouched
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-1" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())

    expect(groupDecision('read')).toHaveAttribute('data-decision', 'allow')
    expect(groupDecision('write')).toHaveAttribute('data-decision', 'review')
    expect(groupDecision('destructive')).toHaveAttribute('data-decision', 'block')
  })

  it('does NOT pre-fill baseline once the account has any saved policy (groups show "default")', async () => {
    // A single unrelated per-scope override makes the account "touched".
    policiesFixture = [{ scope: 'gmail.send', decision: 'block' }]
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-2" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())

    // Every group default is inherit/default, NOT the baseline.
    for (const group of ['read', 'write', 'destructive'] as const) {
      expect(groupDecision(group)).toHaveAttribute('data-decision', 'default')
    }
  })

  it('Save persists the pre-filled baseline as label-default rows', async () => {
    policiesFixture = []
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-3" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())

    screen.getByTestId('scope-policy-save').click()

    await waitFor(() => expect(lastPutBody).not.toBeNull())
    const byScope = Object.fromEntries((lastPutBody!.policies).map((p) => [p.scope, p.decision]))
    // Only the three baseline label rows — no account '*' default, no per-scope rows.
    expect(byScope).toEqual({ '*read': 'allow', '*write': 'review', '*destructive': 'block' })
  })

  it('disables Save for a configured account until a change is made', async () => {
    // Already configured → the form matches what's persisted, so nothing to save.
    policiesFixture = [{ scope: 'gmail.send', decision: 'block' }]
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-4" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())

    expect(screen.getByTestId('scope-policy-save')).toBeDisabled()

    // Flip a risk-level default — now the editor differs from what's persisted.
    await setGroupDecision('read', 'allow')
    await waitFor(() => expect(screen.getByTestId('scope-policy-save')).toBeEnabled())
  })

  it('keeps Save enabled for an untouched account (unsaved baseline)', async () => {
    // No saved rows, but the recommended baseline is pre-filled and not yet
    // persisted — so there genuinely is something to save.
    policiesFixture = []
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-5" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())

    expect(screen.getByTestId('scope-policy-save')).toBeEnabled()
  })

  it('re-disables Save after a successful save', async () => {
    policiesFixture = [{ scope: 'gmail.send', decision: 'block' }]
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-6" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())

    await setGroupDecision('read', 'allow')
    await waitFor(() => expect(screen.getByTestId('scope-policy-save')).toBeEnabled())

    screen.getByTestId('scope-policy-save').click()
    await waitFor(() => expect(lastPutBody).not.toBeNull())
    // The just-saved state is now the persisted baseline → nothing left to save.
    await waitFor(() => expect(screen.getByTestId('scope-policy-save')).toBeDisabled())
  })
})
