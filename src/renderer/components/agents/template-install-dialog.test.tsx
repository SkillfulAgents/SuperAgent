// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

describe('TemplateInstallDialog handoffOrigin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('suppresses autoFocus when handoffOrigin is true', () => {
    render(
      <TemplateInstallDialog
        template={template}
        handoffOrigin
        onClose={() => {}}
        onInstalled={() => {}}
      />,
    )
    const input = screen.getByPlaceholderText('Agent name')
    expect(input).not.toHaveAttribute('autofocus')
  })

  it('autoFocuses the name field when handoffOrigin is omitted', () => {
    render(
      <TemplateInstallDialog template={template} onClose={() => {}} onInstalled={() => {}} />,
    )
    const input = screen.getByPlaceholderText('Agent name')
    expect(input).toHaveFocus()
  })

  // No handoffOrigin: the close-before-install ordering is shared by EVERY caller,
  // including AgentTemplateBrowseDialog, whose onInstalled awaits a refetch and an
  // onboarding session. Asserting it on the bare props keeps that caller covered.
  it('closes the install dialog before onInstalled so setup UI is not stacked', async () => {
    const user = userEvent.setup()
    const order: string[] = []
    mutateAsync.mockResolvedValue({
      slug: 'research-bot',
      displaySlug: 'research-bot',
      hasOnboarding: true,
    })

    render(
      <TemplateInstallDialog
        template={template}
        onClose={() => {
          order.push('close')
        }}
        onInstalled={async () => {
          order.push('onInstalled')
        }}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(order).toEqual(['close', 'onInstalled']))
  })

  it('passes the template prompt through to the navigation handoff', async () => {
    const user = userEvent.setup()
    const onInstalled = vi.fn()
    mutateAsync.mockResolvedValue({
      slug: 'research-bot',
      displaySlug: 'research-bot',
      templatePrompt: 'Investigate this company',
    })

    render(
      <TemplateInstallDialog
        template={template}
        onClose={() => {}}
        onInstalled={onInstalled}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'research-bot',
        templatePrompt: 'Investigate this company',
      }),
    ))
  })
})
