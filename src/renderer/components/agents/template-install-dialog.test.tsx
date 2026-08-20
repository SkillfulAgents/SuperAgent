// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutateAsync = vi.fn()

vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useInstallAgentFromSkillset: () => ({
    mutateAsync,
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}))

import { TemplateInstallDialog } from './template-install-dialog'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

const template: ApiDiscoverableAgent = {
  skillsetId: 'skillset-1',
  skillsetName: 'Public',
  name: 'Research Bot',
  description: 'Does research',
  version: '1.0.0',
  path: 'agents/research-bot/',
}

describe('TemplateInstallDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('installs on open under the template name, with nothing to confirm', async () => {
    mutateAsync.mockResolvedValue({ slug: 'research-bot', displaySlug: 'research-bot' })

    render(<TemplateInstallDialog template={template} onClose={() => {}} onInstalled={() => {}} />)

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        skillsetId: 'skillset-1',
        agentPath: 'agents/research-bot/',
        agentName: 'Research Bot',
        agentVersion: '1.0.0',
      }),
    )
    // The naming step is gone: no field, and no button to press to begin.
    expect(screen.queryByPlaceholderText('Agent name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('shows progress while the install is in flight', () => {
    mutateAsync.mockReturnValue(new Promise(() => {})) // never settles

    render(<TemplateInstallDialog template={template} onClose={() => {}} onInstalled={() => {}} />)

    expect(screen.getByTestId('template-install-status').textContent).toContain('Installing')
  })

  it('fires the install exactly once even if the parent re-renders', async () => {
    mutateAsync.mockResolvedValue({ slug: 'research-bot', displaySlug: 'research-bot' })

    const { rerender } = render(
      <TemplateInstallDialog template={template} onClose={() => {}} onInstalled={() => {}} />,
    )
    rerender(<TemplateInstallDialog template={template} onClose={() => {}} onInstalled={() => {}} />)
    rerender(<TemplateInstallDialog template={template} onClose={() => {}} onInstalled={() => {}} />)

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
  })

  // The close-before-install ordering is shared by EVERY caller, including
  // AgentTemplateBrowseDialog, whose onInstalled awaits a refetch and an
  // onboarding session. Asserting it on the bare props keeps that caller covered.
  it('closes before onInstalled so setup UI is not stacked', async () => {
    const order: string[] = []
    mutateAsync.mockResolvedValue({
      slug: 'research-bot',
      displaySlug: 'research-bot',
      hasOnboarding: true,
    })

    render(
      <TemplateInstallDialog
        template={template}
        onClose={() => order.push('close')}
        onInstalled={async () => {
          order.push('onInstalled')
        }}
      />,
    )

    await waitFor(() => expect(order).toEqual(['close', 'onInstalled']))
  })

  it('passes the template prompt through to the navigation handoff', async () => {
    const onInstalled = vi.fn()
    mutateAsync.mockResolvedValue({
      slug: 'research-bot',
      displaySlug: 'research-bot',
      templatePrompt: 'Investigate this company',
    })

    render(
      <TemplateInstallDialog template={template} onClose={() => {}} onInstalled={onInstalled} />,
    )

    await waitFor(
      () =>
        expect(onInstalled).toHaveBeenCalledWith(
          expect.objectContaining({
            slug: 'research-bot',
            templatePrompt: 'Investigate this company',
          }),
        ),
      { timeout: 3000 },
    )
  })

  it('surfaces a failure instead of closing on it', async () => {
    const onInstalled = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mutateAsync.mockRejectedValue(new Error('Skillset unreachable'))

    render(
      <TemplateInstallDialog template={template} onClose={() => {}} onInstalled={onInstalled} />,
    )

    await waitFor(() => expect(screen.getByText('Skillset unreachable')).toBeTruthy())
    expect(onInstalled).not.toHaveBeenCalled()
  })
})
