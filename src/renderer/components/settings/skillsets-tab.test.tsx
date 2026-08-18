// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ApiSkillsetConfig } from '@shared/lib/types/api'

const skillsetsMock = vi.fn()

vi.mock('@renderer/hooks/use-skillsets', () => ({
  useSkillsets: () => skillsetsMock(),
  useValidateSkillset: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddSkillset: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveSkillset: () => ({ mutate: vi.fn(), isPending: false }),
  useRefreshSkillset: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSkillsetCredential: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

import { SkillsetsTab } from './skillsets-tab'

function makeSkillset(overrides: Partial<ApiSkillsetConfig>): ApiSkillsetConfig {
  return {
    id: 'ss-1',
    url: 'https://github.com/org/repo',
    name: 'repo',
    displayName: 'repo',
    description: 'A repo',
    skillCount: 0,
    agentCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    showUrl: true,
    publishMode: 'pull_request',
    ...overrides,
  }
}

describe('SkillsetsTab', () => {
  it('labels the page Libraries and uses provider display names', () => {
    skillsetsMock.mockReturnValue({
      data: [
        makeSkillset({
          id: 'platform--repo--datawizz-test',
          name: 'datawizz-test',
          displayName: 'Datawizz Test Team Library',
          description: 'Default library for Datawizz Test',
          skillCount: 4,
          provider: 'platform',
          badgeLabel: 'Platform',
          showUrl: false,
        }),
        makeSkillset({
          id: 'public-skillset',
          name: 'Gamut Public Skillset',
          displayName: 'Gamut Public Skillset',
          description: 'A public collection',
          url: 'https://github.com/SkillfulAgents/public-skillset',
          provider: 'public',
          badgeLabel: 'Public',
        }),
      ],
      isLoading: false,
    })

    render(<SkillsetsTab />)

    expect(screen.getByRole('heading', { name: 'Libraries' })).toBeInTheDocument()
    expect(screen.getByText('Datawizz Test Team Library')).toBeInTheDocument()
    expect(screen.getByText('Default library for Datawizz Test')).toBeInTheDocument()
    expect(screen.queryByText('datawizz-test')).not.toBeInTheDocument()
    expect(screen.queryByText(/Default skillset for/)).not.toBeInTheDocument()
    expect(screen.getByText('Gamut Public Skillset')).toBeInTheDocument()
  })

  it('shows an empty Libraries state', () => {
    skillsetsMock.mockReturnValue({ data: [], isLoading: false })
    render(<SkillsetsTab />)
    expect(screen.getByText('No libraries configured yet.')).toBeInTheDocument()
  })
})
