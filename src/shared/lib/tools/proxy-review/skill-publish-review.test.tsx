// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillPublishReview } from '@shared/lib/proxy/skill-publish-review'
import { ProxyReviewRequestItem } from './request'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { pathname: '/agents/my-agent/sessions/s1', searchStr: '' } } }),
}))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useAgentConnectedAccounts: () => ({ data: { accounts: [] } }),
}))
vi.mock('@renderer/hooks/use-remote-mcps', () => ({
  useAgentRemoteMcps: () => ({ data: { mcps: [] } }),
}))

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const publish: SkillPublishReview = {
  skillName: 'Invoice Parser',
  skillDirectory: 'invoice-parser',
  skillsetName: 'Team Skills',
  description: 'Read fields from invoice PDFs',
  agentNote: 'The finance team asks for this every week',
  files: ['SKILL.md', 'scripts/parse.py'],
  updatesPublishedSkill: false,
}

function renderCard(skillPublish: SkillPublishReview = publish) {
  return render(
    <ProxyReviewRequestItem
      reviewId="review-1"
      agentSlug="my-agent"
      accountId="team-skills"
      toolkit="Team skills"
      method="PUBLISH"
      targetPath="team-skills/invoice-parser"
      matchedScopes={[]}
      scopeDescriptions={{}}
      displayText={'Publish skill "Invoice Parser" to Team Skills?'}
      skillPublish={skillPublish}
      onComplete={vi.fn()}
    />,
  )
}

function sentDecision(): unknown {
  expect(mockApiFetch).toHaveBeenCalledOnce()
  const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit]
  expect(url).toBe('/api/agents/my-agent/proxy-review/review-1')
  return JSON.parse(init.body as string)
}

describe('skill publish approval card', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
    mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  })

  it('shows what will be published and offers no way to always allow it', () => {
    renderCard()

    expect(screen.getByText('Publish skill "Invoice Parser" to Team Skills?')).toBeInTheDocument()
    expect(screen.getByTestId('skill-publish-description')).toHaveTextContent('Read fields from invoice PDFs')
    expect(screen.getByText('The finance team asks for this every week')).toBeInTheDocument()
    expect(screen.getByTestId('skill-publish-files')).toHaveTextContent('SKILL.md')
    expect(screen.getByTestId('skill-publish-files')).toHaveTextContent('scripts/parse.py')
    expect(screen.getByTestId('skill-publish-kind')).toHaveTextContent('New skill')
    expect(screen.queryByTestId('proxy-review-always-allow-btn')).not.toBeInTheDocument()
  })

  it('marks a change to a skill the team already has', () => {
    renderCard({ ...publish, updatesPublishedSkill: true })

    expect(screen.getByTestId('skill-publish-kind')).toHaveTextContent('Updates a published skill')
  })

  it('sends one allow decision when the person publishes', async () => {
    renderCard()

    await userEvent.setup().click(screen.getByTestId('skill-publish-approve-btn'))

    expect(sentDecision()).toEqual({ decision: 'allow' })
    await waitFor(() => expect(screen.getByTestId('skill-publish-completed')).toHaveTextContent('Approved'))
  })

  it('sends a deny decision when the person rejects', async () => {
    renderCard()

    await userEvent.setup().click(screen.getByTestId('skill-publish-reject-btn'))

    expect(sentDecision()).toEqual({ decision: 'deny' })
    await waitFor(() => expect(screen.getByTestId('skill-publish-completed')).toHaveTextContent('Rejected'))
  })

  it('keeps the card open and shows the reason when the host refuses the approver', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden: only an owner of this agent can approve publishing its skills' }) })
    renderCard()

    await userEvent.setup().click(screen.getByTestId('skill-publish-approve-btn'))

    expect(await screen.findByText(/only an owner of this agent can approve/)).toBeInTheDocument()
    expect(screen.getByTestId('skill-publish-request')).toBeInTheDocument()
  })
})
