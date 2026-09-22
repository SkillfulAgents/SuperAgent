// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSkillsetConfig } from '@shared/lib/types/api'

let skillsets: ApiSkillsetConfig[] | undefined = []

vi.mock('@renderer/hooks/use-skillsets', () => ({
  useSkillsets: () => ({ data: skillsets }),
}))

vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useAgentTemplatePublishInfo: () => ({ data: undefined, isLoading: false, error: null }),
  usePublishAgentTemplate: () => ({
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}))

import { AgentTemplatePublishPanel } from './agent-template-publish-panel'

function skillset(over: Partial<ApiSkillsetConfig> = {}): ApiSkillsetConfig {
  return {
    id: 'github-skillset',
    url: 'https://github.com/org/team-skillset',
    name: 'Team Skillset',
    description: 'Writable GitHub skillset',
    skillCount: 1,
    agentCount: 0,
    addedAt: '2026-01-01',
    showUrl: true,
    publishMode: 'pull_request',
    ...over,
  }
}

async function goToPicker(user: ReturnType<typeof userEvent.setup>) {
  render(<AgentTemplatePublishPanel agentSlug="test-agent" onBack={vi.fn()} />)
  await user.type(screen.getByLabelText('Title'), 'Add agent')
  await user.type(screen.getByLabelText('Description'), 'A new agent template')
  await user.click(screen.getByTestId('publish-flow-submit'))
}

beforeEach(() => {
  skillsets = [
    skillset({
      id: 'public-skillset',
      name: 'Gamut Public Skillset',
      description: 'Default public skillset',
      publishMode: 'none',
    }),
    skillset(),
  ]
})

describe('AgentTemplatePublishPanel', () => {
  it('lists a read-only skillset as Read only and keeps the writable one selected', async () => {
    const user = userEvent.setup()
    await goToPicker(user)

    expect(screen.getByText('Choose a skillset')).toBeInTheDocument()
    expect(screen.queryByText(/library/i)).not.toBeInTheDocument()

    const readOnly = screen.getByTestId('publish-skillset-option-public-skillset')
    expect(readOnly).toHaveTextContent('Read only')
    expect(readOnly).toBeDisabled()
    expect(readOnly).toHaveAttribute('aria-checked', 'false')

    expect(screen.getByTestId('publish-skillset-option-github-skillset')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByTestId('publish-flow-publish')).toBeEnabled()
  })

  it('disables Publish when every skillset is read only', async () => {
    skillsets = [
      skillset({
        id: 'public-skillset',
        name: 'Gamut Public Skillset',
        publishMode: 'none',
      }),
    ]
    const user = userEvent.setup()
    await goToPicker(user)

    expect(screen.getByTestId('publish-skillset-option-public-skillset')).toBeDisabled()
    expect(screen.getByTestId('publish-flow-publish')).toBeDisabled()
  })
})
