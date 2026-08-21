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

/** A segment of a scope row's three-way toggle. */
const scopeToggle = (scope: string, decision: 'allow' | 'review' | 'block') =>
  within(screen.getByTestId(`scope-row-${scope}`)).getByTestId(`policy-toggle-${decision}`)

/** Expands a risk group so its scope rows render. */
const expandGroup = async (group: string) => {
  screen.getByTestId(`scope-group-toggle-${group}`).click()
  await waitFor(() => expect(screen.getByTestId('scope-row-gmail.readonly')).toBeInTheDocument())
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

  it('shows the group decision on scopes that have no rule of their own', async () => {
    policiesFixture = []
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-7" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())
    await expandGroup('read')

    // Read group is on the 'allow' baseline, so its scopes display allow —
    // flagged as inherited, not as a rule set on the scope.
    expect(scopeToggle('gmail.readonly', 'allow')).toHaveAttribute('data-active', 'true')
    expect(scopeToggle('gmail.readonly', 'allow')).toHaveAttribute('data-inherited', 'true')
    expect(scopeToggle('gmail.readonly', 'block')).toHaveAttribute('data-active', 'false')

    // Moving the group moves what its scopes display.
    await setGroupDecision('read', 'block')
    await waitFor(() =>
      expect(scopeToggle('gmail.readonly', 'block')).toHaveAttribute('data-active', 'true'),
    )
    expect(scopeToggle('gmail.readonly', 'allow')).toHaveAttribute('data-active', 'false')
  })

  it('a scope with its own rule keeps it, and shows it as explicit', async () => {
    policiesFixture = [
      { scope: '*read', decision: 'allow' },
      { scope: 'gmail.readonly', decision: 'block' },
    ]
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-8" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())
    await expandGroup('read')

    // The override wins over the group's allow, and reads as set-here.
    expect(scopeToggle('gmail.readonly', 'block')).toHaveAttribute('data-active', 'true')
    expect(scopeToggle('gmail.readonly', 'block')).toHaveAttribute('data-inherited', 'false')
    // A sibling with no rule of its own inherits the group instead.
    expect(scopeToggle('gmail.metadata', 'allow')).toHaveAttribute('data-inherited', 'true')
  })

  it('changing a group writes only its sentinel — never a row per scope', async () => {
    policiesFixture = [{ scope: 'gmail.send', decision: 'block' }]
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-9" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())

    await setGroupDecision('read', 'allow')
    await waitFor(() => expect(screen.getByTestId('scope-policy-save')).toBeEnabled())
    screen.getByTestId('scope-policy-save').click()

    await waitFor(() => expect(lastPutBody).not.toBeNull())
    const byScope = Object.fromEntries(lastPutBody!.policies.map((p) => [p.scope, p.decision]))
    // The group sentinel plus the pre-existing override — the four other read
    // scopes stay on inherit rather than being materialized as their own rows.
    expect(byScope).toEqual({ '*read': 'allow', 'gmail.send': 'block' })
  })

  it('clicking an inherited scope pins it as that scope’s own rule', async () => {
    policiesFixture = [{ scope: '*read', decision: 'allow' }]
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-10" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())
    await expandGroup('read')

    // Clicking the segment it already displays promotes inherit → explicit
    // rather than deselecting (there is nothing of its own to remove yet).
    expect(scopeToggle('gmail.readonly', 'allow')).toHaveAttribute('data-inherited', 'true')
    scopeToggle('gmail.readonly', 'allow').click()
    await waitFor(() =>
      expect(scopeToggle('gmail.readonly', 'allow')).toHaveAttribute('data-inherited', 'false'),
    )
    expect(scopeToggle('gmail.readonly', 'allow')).toHaveAttribute('data-active', 'true')

    // And now it can be cleared back to inherit.
    scopeToggle('gmail.readonly', 'allow').click()
    await waitFor(() =>
      expect(scopeToggle('gmail.readonly', 'allow')).toHaveAttribute('data-inherited', 'true'),
    )
  })

  it('Reset defaults restores the group baselines and the account fallback', async () => {
    policiesFixture = [
      { scope: '*', decision: 'block' },
      { scope: '*read', decision: 'block' },
      { scope: 'gmail.send', decision: 'allow' },
    ]
    renderWithProviders(
      <ScopePolicyEditor accountId="acc-11" toolkit="gmail" open onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())

    screen.getByTestId('reset-recommended-defaults').click()
    await waitFor(() => expect(groupDecision('read')).toHaveAttribute('data-decision', 'allow'))

    screen.getByTestId('scope-policy-save').click()
    await waitFor(() => expect(lastPutBody).not.toBeNull())
    const byScope = Object.fromEntries(lastPutBody!.policies.map((p) => [p.scope, p.decision]))
    // Baselines restored and the account '*' fallback cleared; the deliberate
    // per-scope override is not a default, so it survives.
    expect(byScope).toEqual({
      '*read': 'allow',
      '*write': 'review',
      '*destructive': 'block',
      'gmail.send': 'allow',
    })
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
