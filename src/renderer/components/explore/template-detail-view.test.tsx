// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()
const historyBack = vi.fn()
const canGoBack = vi.fn()
let locationState: { __TSR_index: number; exploreReturnKey?: string } = { __TSR_index: 0 }
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouter: () => ({
    history: {
      location: { state: locationState },
      canGoBack,
      back: historyBack,
    },
  }),
  useLocation: ({ select }: { select: (location: object) => unknown }) =>
    select({ state: locationState }),
}))

const openSettings = vi.fn()
vi.mock('@renderer/context/dialog-context', () => ({ useDialogs: () => ({ openSettings }) }))

vi.mock('@renderer/hooks/use-complete-template-install', () => ({
  useCompleteTemplateInstall: () => vi.fn(),
}))
vi.mock('@renderer/components/agents/template-install-dialog', () => ({
  TemplateInstallDialog: () => null,
}))

let skillsets: unknown[] | undefined = []
let discoverable: ApiDiscoverableAgent[] | undefined
let isLoading = false
vi.mock('@renderer/hooks/use-skillsets', () => ({ useSkillsets: () => ({ data: skillsets }) }))
vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useDiscoverableAgents: () => ({ data: discoverable, isLoading }),
  slugFromAgentPath: (path: string) => path.replace(/^agents\//, '').replace(/\/$/, ''),
}))

import { TemplateDetailView } from './template-detail-view'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

// The `## Credits` body verbatim from the public skillset's `Account Expert` —
// the shape 160 of its 168 templates ship, absolute links and repo-relative
// link together.
const CREDITS =
  '## Credits\n\nOriginal prompt credited to [@kristaletz](https://x.com/kristaletz) on ' +
  '[Bot Directory](https://botdirectory.ai/bots/account-expert/). Imported from the ' +
  'MIT-licensed catalog; see the [attribution and license](../../sources/botdirectory/NOTICE.md).'

const template: ApiDiscoverableAgent = {
  skillsetId: 'skillset-1',
  skillsetName: 'Public',
  name: 'Account Expert',
  description: 'Tracks an account',
  version: '1.0.0',
  path: 'agents/account-expert/',
  details: CREDITS,
  developer: { name: '@kristaletz', url: 'https://x.com/kristaletz' },
}

function renderDetail(slug = 'account-expert') {
  return render(<TemplateDetailView skillsetId="skillset-1" templateSlug={slug} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  locationState = { __TSR_index: 0 }
  canGoBack.mockReturnValue(true)
  skillsets = [{ id: 'skillset-1' }]
  discoverable = [template]
  isLoading = false
})

describe('TemplateDetailView back navigation', () => {
  it('returns to the originating marketplace history entry', async () => {
    locationState = { __TSR_index: 1, exploreReturnKey: 'explore-entry' }
    renderDetail()

    await userEvent.click(screen.getByRole('button', { name: 'Discover New Agents' }))

    expect(historyBack).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('falls back to the marketplace route for a directly opened template', async () => {
    renderDetail()

    await userEvent.click(screen.getByRole('button', { name: 'Discover New Agents' }))

    expect(historyBack).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({ to: '/explore' })
  })
})

/**
 * The details body is markdown from a third-party git repo. Nothing in front of
 * a same-window navigation catches it: there is no `will-navigate` handler in
 * the main process, and no Reload or Back in the app menu — so an unguarded
 * link replaces the whole app and the only way back is relaunching.
 * `target="_blank"` is what avoids that on BOTH targets: a tab on the web, and
 * in Electron the one path that reaches setWindowOpenHandler → the default
 * browser.
 */
describe('TemplateDetailView body links', () => {
  it('opens absolute links out of the window', () => {
    renderDetail()
    const external = screen.getByRole('link', { name: 'Bot Directory' })
    expect(external).toHaveAttribute('href', 'https://botdirectory.ai/bots/account-expert/')
    expect(external).toHaveAttribute('target', '_blank')
    expect(external).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('never leaves a body link that would navigate this window', () => {
    renderDetail()
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank')
    }
  })

  it('renders a repo-relative link as text, keeping its words', () => {
    renderDetail()
    expect(screen.queryByRole('link', { name: 'attribution and license' })).toBeNull()
    expect(screen.getByText(/attribution and license/)).toBeTruthy()
  })

  it('refuses a dangerous scheme instead of linking it', () => {
    discoverable = [
      // eslint-disable-next-line no-script-url
      { ...template, details: '## Credits\n\n[click me](javascript:alert(1))' },
    ]
    renderDetail()
    expect(screen.queryByRole('link', { name: 'click me' })).toBeNull()
    expect(screen.getByText('click me')).toBeTruthy()
  })

  it('applies the same policy to the developer row', () => {
    discoverable = [{ ...template, details: undefined }]
    renderDetail()
    const developer = screen.getByRole('link', { name: '@kristaletz' })
    expect(developer).toHaveAttribute('href', 'https://x.com/kristaletz')
    expect(developer).toHaveAttribute('target', '_blank')

    discoverable = [
      { ...template, details: undefined, developer: { name: 'Someone', url: 'file:///etc/passwd' } },
    ]
    renderDetail()
    expect(screen.queryByRole('link', { name: 'Someone' })).toBeNull()
    expect(screen.getAllByText('Someone').length).toBeGreaterThan(0)
  })
})

/**
 * `useDiscoverableAgents` is `enabled: hasSkillsets`, so with none configured it
 * never runs and its data stays undefined. Branching on the data alone leaves a
 * skeleton that never resolves.
 */
describe('TemplateDetailView with no skillsets', () => {
  it('shows the empty state rather than a skeleton that never resolves', () => {
    skillsets = []
    discoverable = undefined
    renderDetail()
    expect(screen.getByTestId('explore-empty')).toBeTruthy()
    expect(screen.queryByTestId('template-not-found')).toBeNull()
  })

  it('still shows a skeleton while the skillset list is loading', () => {
    skillsets = undefined
    discoverable = undefined
    const { container } = renderDetail()
    expect(screen.queryByTestId('explore-empty')).toBeNull()
    expect(screen.queryByTestId('template-not-found')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('reports a genuinely missing template as missing', () => {
    renderDetail('not-a-real-template')
    expect(screen.getByTestId('template-not-found')).toBeTruthy()
  })
})
