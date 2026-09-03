// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiSkillsetConfig } from '@shared/lib/types/api'

let skillsets: ApiSkillsetConfig[] | undefined = []

vi.mock('@renderer/hooks/use-skillsets', () => ({
  useSkillsets: () => ({ data: skillsets }),
}))

vi.mock('@renderer/hooks/use-agent-skills', () => ({
  useSkillPublishInfo: () => ({ data: undefined, isLoading: false, error: null }),
  usePublishSkill: () => ({
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}))

vi.mock('@renderer/components/ui/dialog', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    Dialog: Passthrough,
    DialogContent: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
  }
})

import { SkillPublishDialog } from './skill-publish-dialog'

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

describe('SkillPublishDialog', () => {
  it('lists a read-only skillset as Read only and does not open the publish form', async () => {
    const user = userEvent.setup()
    render(
      <SkillPublishDialog
        open
        onOpenChange={vi.fn()}
        agentSlug="test-agent"
        skillDir="my-skill"
        skillStatus={{ type: 'local' }}
        onOpenReview={vi.fn()}
      />,
    )

    const readOnly = screen.getByTestId('publish-skillset-option-public-skillset')
    expect(readOnly).toHaveTextContent('Read only')
    expect(readOnly).toBeDisabled()

    await user.click(readOnly)
    expect(screen.queryByLabelText('PR Title')).not.toBeInTheDocument()
  })

  it('opens the publish form when a writable skillset is chosen', async () => {
    const user = userEvent.setup()
    render(
      <SkillPublishDialog
        open
        onOpenChange={vi.fn()}
        agentSlug="test-agent"
        skillDir="my-skill"
        skillStatus={{ type: 'local' }}
        onOpenReview={vi.fn()}
      />,
    )

    await user.click(screen.getByTestId('publish-skillset-option-github-skillset'))
    expect(screen.getByLabelText('PR Title')).toBeInTheDocument()
  })
})
