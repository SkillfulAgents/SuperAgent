// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VolumeSetupProps } from '@renderer/components/volumes/volume-setup'
import type { TeamBrainSetup } from '@shared/lib/config/team-brain-schema'

const DRIVE = { accountId: 'acct', folderId: 'folder1', folderName: 'Brain', driveName: 'My Drive' }

// The set-up server, faked at the HTTP boundary: the hook, the page and the window run for real.
const { app, user } = vi.hoisted(() => ({
  app: {
    calls: [] as string[],
    agentsPending: false,
    agents: [] as Array<{ slug: string; displaySlug: string; name: string; status: string; avatar: null; teamBrain?: { volumeId: string } }>,
    setup: null as TeamBrainSetup | null,
    /** The next step 1 is answered as another admin's set-up would be: stale, with theirs. */
    otherAdmin: null as TeamBrainSetup | null,
    /** Another admin finished the set-up: the next save is refused as ready. */
    finishedElsewhere: false,
    health: 'ok' as 'ok' | 'preparing' | 'missing' | 'loading',
    pollFailed: false,
    recheck: vi.fn(async () => {}),
    startAgent: vi.fn(() => { app.calls.push('warm-start') }),
    session: vi.fn(async () => { app.calls.push('session') }),
    skillsets: [] as Array<{ id: string }>,
    skillsetsFailed: false,
    rereadSkillsets: vi.fn(),
    addSkillset: vi.fn(async () => {}),
  },
  user: { isAuthMode: false, isAdmin: false, user: null },
}))

const answer = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body })

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : {}
    if (!url.startsWith('/api/team-brain/setup')) return answer(200, {})
    if (method === 'GET') return app.setup ? answer(200, { setup: app.setup }) : answer(404, { reason: 'none' })
    app.calls.push(`${method} ${url.replace('/api/team-brain/setup', '') || '/'}${body.step ? ` step ${body.step}` : ''}${body.schedule ? ` ${body.schedule}` : ''}`)
    if (url.endsWith('/finish')) {
      app.setup = null
      app.agents = [...app.agents, { slug: 'team-brain', displaySlug: 'team-brain', name: 'Team Brain', status: 'stopped', avatar: null, teamBrain: { volumeId: 'vol1' } }]
      return answer(200, { agentSlug: 'team-brain', firstPrompt: 'Set up our team brain', failedAgents: 0 })
    }
    if (method === 'DELETE') {
      app.setup = null
      return answer(204)
    }
    if (method === 'POST') {
      if (app.otherAdmin) {
        app.setup = app.otherAdmin
        app.otherAdmin = null
        return answer(409, { error: 'Another Team Brain set-up is in progress', reason: 'stale', setup: app.setup })
      }
      if (!app.setup && body.setupId) return answer(404, { error: 'Team Brain set-up was discarded', reason: 'discarded' })
      app.setup = {
        status: 'setting-up', setupId: 's1', schedule: 'daily', everyAgent: true, agents: {},
        ...app.setup,
        agentSlug: 'team-brain',
        volumeId: body.drive ? 'vol1' : app.setup?.volumeId ?? null,
        location: body.drive?.source.type ?? app.setup?.location ?? null,
        step: body.drive && (!app.setup || app.setup.step === 'location') ? 'agents' : app.setup?.step ?? 'location',
      }
      return answer(200, { setup: app.setup })
    }
    if (app.finishedElsewhere) return answer(409, { error: 'Team Brain is already set up', reason: 'ready' })
    if (!app.setup) return answer(404, { error: 'Team Brain set-up was discarded', reason: 'discarded' })
    const changes = { ...body, setupId: app.setup.setupId }
    app.setup = { ...app.setup, ...changes, agents: { ...app.setup.agents, ...changes.agents } }
    return answer(200, { setup: app.setup })
  }),
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: app.agentsPending ? undefined : app.agents, isPending: app.agentsPending }),
  useStartAgent: () => ({ mutate: app.startAgent }),
}))
vi.mock('@renderer/hooks/use-skillsets', () => ({
  useSkillsets: () => ({ data: app.skillsets, isError: app.skillsetsFailed, refetch: app.rereadSkillsets }),
  useAddSkillset: () => ({ mutateAsync: app.addSkillset }),
}))
vi.mock('@renderer/hooks/use-mounts', () => ({
  useAgentMounts: (slug: string) => ({
    data: slug && app.health !== 'loading' ? [{ id: `m-${slug}`, volumeId: 'vol1', health: app.health }] : undefined,
    isError: app.pollFailed,
    refetch: app.recheck,
  }),
}))
vi.mock('@renderer/hooks/use-start-onboarding-session', () => ({ useStartOnboardingSession: () => app.session }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({ useConnectedAccounts: () => ({ data: undefined }) }))
vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: undefined }) }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => user }))
vi.mock('@renderer/context/onboarding-context', () => ({ useOnboarding: () => ({ setOnboarding: vi.fn() }) }))
vi.mock('@renderer/components/ui/app-link', () => ({ AppLink: ({ children }: { children: unknown }) => <span>{children as string}</span> }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }) }))
// The home page has its own tests; here it only needs to show up, for the right agent.
vi.mock('./team-brain-overview', () => ({ TeamBrainOverview: ({ agent }: { agent: { slug: string } }) => <div data-testid="team-brain-home">{agent.slug}</div> }))
// The drive's own set-up, reduced to its save.
vi.mock('@renderer/components/volumes/volume-setup-registry', async (importOriginal) => {
  const { volumeSetupRegistry } = await importOriginal<typeof import('@renderer/components/volumes/volume-setup-registry')>()
  const Setup = ({ initialDetails, onSubmit, error }: VolumeSetupProps) => (
    <>
      <button type="button" data-testid="drive-save" onClick={() => void onSubmit(DRIVE, initialDetails)}>Save</button>
      {error && <p role="alert">{error}</p>}
    </>
  )
  return { volumeSetupRegistry: { ...volumeSetupRegistry, googledrive: { ...volumeSetupRegistry.googledrive, Setup } } }
})

import { toast } from 'sonner'
import { TeamBrainPage as Page } from './team-brain-page'
import { volumeSetupRegistry } from '@renderer/components/volumes/volume-setup-registry'
import { getTeamBrainState, resetTeamBrainState } from '@renderer/lib/team-brain/team-brain-store'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'

const agent = (slug: string) => ({ slug, displaySlug: slug, name: slug[0].toUpperCase() + slug.slice(1), status: 'stopped', avatar: null })
const SAVED: TeamBrainSetup = {
  status: 'setting-up', setupId: 's1', agentSlug: 'team-brain', volumeId: 'vol1', location: 'googledrive',
  step: 'schedule', schedule: 'weekly', everyAgent: false, agents: { writer: true },
}

let client: QueryClient
const invalidate = () => vi.spyOn(client, 'invalidateQueries')
function TeamBrainPage() {
  return <QueryClientProvider client={client}><Page /></QueryClientProvider>
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  resetTeamBrainState()
  app.calls.length = 0
  app.agents = [agent('writer'), agent('planner')]
  app.setup = null
  app.otherAdmin = null
  app.finishedElsewhere = false
  app.health = 'ok'
  app.pollFailed = false
  app.skillsets = [{ id: DEFAULT_PUBLIC_SKILLSET.id }]
  app.skillsetsFailed = false
  Object.assign(user, { isAuthMode: false, isAdmin: false })
})
afterEach(() => {
  cleanup()
  resetTeamBrainState()
  vi.clearAllMocks()
})

async function saveDrive(clicker: ReturnType<typeof userEvent.setup>) {
  await clicker.click(await screen.findByTestId('team-brain-start'))
  // Choosing a home only selects it; Next opens its set-up.
  await clicker.click(screen.getByTestId('team-brain-location-googledrive'))
  expect(screen.queryByTestId('drive-save')).toBeNull()
  expect(screen.getByTestId('team-brain-next')).toHaveTextContent('Next: Set up Google Drive')
  await clicker.click(screen.getByTestId('team-brain-next'))
  await clicker.click(screen.getByTestId('drive-save'))
}

describe('TeamBrainPage', () => {
  it('shows nothing while the agents load, so a reload never flashes the pitch before the home page', () => {
    app.agentsPending = true
    const { container } = render(<TeamBrainPage />)
    expect(container).toBeEmptyDOMElement()
    app.agentsPending = false
  })

  it('opens on the pitch, and Set up opens the window at where it lives with nothing chosen', async () => {
    render(<TeamBrainPage />)
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('One source of truth for every agent.')

    await userEvent.click(screen.getByTestId('team-brain-start'))
    expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'location')
    // Every drive type the drives offer, Google Drive and Dropbox first, then the rest in the drives' own order.
    const homes = screen.getAllByTestId(/^team-brain-location-/)
    const rest = Object.values(volumeSetupRegistry).map((drive) => drive.type).filter((id) => id !== 'googledrive' && id !== 'dropbox')
    expect(homes.map((home) => home.dataset.testid)).toEqual(['googledrive', 'dropbox', ...rest].map((id) => `team-brain-location-${id}`))
    for (const home of homes) expect(home).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('team-brain-next')).toBeDisabled()
    // Opening the window claims nothing.
    expect(app.calls).toEqual([])
  })

  it('claims the set-up when the drive is saved, saves each choice as it changes, and Back saves nothing', async () => {
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents'))
    await waitFor(() => expect(app.calls).toEqual(['POST /', 'warm-start']))
    expect(app.setup?.step).toBe('agents')

    await clicker.click(screen.getByTestId('team-brain-every-agent-switch'))
    await clicker.click(screen.getByTestId('team-brain-agent-writer'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-schedule-weekly'))
    await waitFor(() => expect(app.setup).toMatchObject({ step: 'schedule', schedule: 'weekly', everyAgent: false, agents: { writer: true } }))
    const saved = app.calls.length

    await clicker.click(screen.getByTestId('team-brain-back'))
    expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents')
    expect(app.calls).toHaveLength(saved)
  })

  it('closes without asking and keeps the set-up: the pitch offers Resume and Discard', async () => {
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(app.setup?.step).toBe('agents'))
    const saved = app.calls.length
    await clicker.click(screen.getByTestId('team-brain-cancel'))
    expect(screen.queryByTestId('team-brain-onboarding')).toBeNull()
    // The fading window keeps showing its step, not step 1.
    expect(getTeamBrainState()).toMatchObject({ status: 'off', step: 'agents' })
    expect(app.calls).toHaveLength(saved)
    expect(screen.getByTestId('team-brain-resume')).toBeInTheDocument()
    expect(screen.getByTestId('team-brain-discard')).toBeInTheDocument()
    expect(screen.queryByTestId('team-brain-start')).toBeNull()
  })

  it('resumes another admin’s set-up after a reload at its saved step, with its saved choices', async () => {
    const clicker = userEvent.setup()
    app.setup = SAVED
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-resume'))
    expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'schedule')
    expect(screen.getByTestId('team-brain-schedule-weekly')).toHaveAttribute('aria-checked', 'true')
    await clicker.click(screen.getByTestId('team-brain-back'))
    expect(screen.getByTestId('team-brain-agent-writer')).toBeChecked()
    expect(screen.getByTestId('team-brain-agent-planner')).not.toBeChecked()
    // Resume only reopens the window: it changes nothing on the server.
    expect(app.calls.filter((call) => call !== 'warm-start')).toEqual([])
  })

  it('discards after a confirm, and the pitch goes back to Set up', async () => {
    const clicker = userEvent.setup()
    app.setup = SAVED
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-discard'))
    expect(screen.getByText('Discard Team Brain set-up?')).toBeInTheDocument()
    expect(screen.getByText(/The Team Brain agent and drive made so far will be removed/)).toBeInTheDocument()
    await clicker.click(screen.getByTestId('team-brain-discard-confirm'))
    await waitFor(() => expect(screen.getByTestId('team-brain-start')).toBeInTheDocument())
    expect(app.calls.filter((call) => call !== 'warm-start')).toEqual(['DELETE ?setupId=s1'])
  })

  it('switches to another admin’s set-up when theirs was claimed first, and says so', async () => {
    const clicker = userEvent.setup()
    app.otherAdmin = { ...SAVED, setupId: 's2', step: 'agents' }
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents'))
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Another admin already started setting up Team Brain. You’re continuing it.')
  })

  it('closes when its set-up was discarded by another admin, and says so', async () => {
    const clicker = userEvent.setup()
    app.setup = SAVED
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-resume'))
    app.setup = null
    await clicker.click(screen.getByTestId('team-brain-schedule-daily'))
    await waitFor(() => expect(screen.queryByTestId('team-brain-onboarding')).toBeNull())
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Team Brain set-up was discarded.')
  })

  it('closes when another admin finished the set-up, and says so', async () => {
    const clicker = userEvent.setup()
    app.setup = SAVED
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-resume'))
    app.finishedElsewhere = true
    await clicker.click(screen.getByTestId('team-brain-schedule-daily'))
    await waitFor(() => expect(screen.queryByTestId('team-brain-onboarding')).toBeNull())
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Another admin finished setting up Team Brain.')
  })

  it('starts the agent once its drive has copied, and offers Start chat only then', async () => {
    const clicker = userEvent.setup()
    app.health = 'preparing'
    app.setup = { ...SAVED, step: 'intake' }
    const page = render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-resume'))
    // Started now, the agent would run without the drive it is about to build.
    expect(app.calls).not.toContain('warm-start')
    expect(screen.getByTestId('team-brain-start-chat')).toBeDisabled()
    expect(screen.getByTestId('team-brain-start-chat')).toHaveTextContent('Copying the drive…')

    // A poll that fails after one that said copying may be out of date: still not ready.
    app.pollFailed = true
    page.rerender(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-start-chat')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t check the drive.')
    await clicker.click(screen.getByRole('button', { name: 'Try again' }))
    expect(app.recheck).toHaveBeenCalled()
    app.pollFailed = false

    app.health = 'ok'
    page.rerender(<TeamBrainPage />)
    await waitFor(() => expect(app.calls).toContain('warm-start'))
    expect(screen.getByTestId('team-brain-start-chat')).toBeEnabled()
  })

  it('Start chat finishes on the server, then opens the first chat, and the page shows Team Brain', async () => {
    const clicker = userEvent.setup()
    app.setup = { ...SAVED, step: 'intake' }
    const page = render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-resume'))
    app.session.mockImplementationOnce(async () => {
      // Under the "Setting up your agent..." card the page is blank: no window, no pitch.
      expect(screen.queryByTestId('team-brain-onboarding')).toBeNull()
      expect(screen.queryByTestId('team-brain-intro')).toBeNull()
      app.calls.push('session')
    })
    await clicker.click(screen.getByTestId('team-brain-start-chat'))
    await waitFor(() => expect(app.calls).toContain('session'))
    expect(app.calls.slice(-2)).toEqual(['POST /finish', 'session'])
    expect(app.session).toHaveBeenCalledWith('team-brain', 'Set up our team brain')
    expect(getTeamBrainState().status).toBe('off')
    page.rerender(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-home')).toHaveTextContent('team-brain')
  })

  it('names a missing Gamut Public Skillset before any drive set-up, and adds it as new workspaces have it', async () => {
    const clicker = userEvent.setup()
    app.skillsets = [{ id: 'github-com-acme-skills' }]
    app.addSkillset.mockImplementationOnce(async () => {
      app.calls.push('add skillset')
      app.skillsets = [...app.skillsets, { id: DEFAULT_PUBLIC_SKILLSET.id }]
    })
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-start'))
    await clicker.click(screen.getByTestId('team-brain-location-googledrive'))
    expect(screen.getByTestId('team-brain-next')).toBeDisabled()

    await clicker.click(within(screen.getByTestId('team-brain-public-skillset-missing')).getByRole('button'))
    expect(app.addSkillset).toHaveBeenCalledWith({ url: DEFAULT_PUBLIC_SKILLSET.url, provider: DEFAULT_PUBLIC_SKILLSET.provider })
    await waitFor(() => expect(screen.queryByTestId('team-brain-public-skillset-missing')).toBeNull())
    expect(screen.getByTestId('team-brain-next')).toBeEnabled()
  })

  it('keeps the notice and reads both lists again when the add fails, since another admin may have added it', async () => {
    const clicker = userEvent.setup()
    app.skillsets = [{ id: 'github-com-acme-skills' }]
    app.addSkillset.mockRejectedValueOnce(new Error('Failed to download skillset: 403 Forbidden'))
    const reread = invalidate()
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-start'))
    await clicker.click(screen.getByTestId('team-brain-location-googledrive'))
    const notice = screen.getByTestId('team-brain-public-skillset-missing')
    await clicker.click(within(notice).getByRole('button'))

    expect(await within(notice).findByText('Failed to download skillset: 403 Forbidden')).toBeInTheDocument()
    expect(reread).toHaveBeenCalledWith({ queryKey: ['skillsets'] })
    expect(reread).toHaveBeenCalledWith({ queryKey: ['discoverable-agents'] })
    expect(screen.getByTestId('team-brain-next')).toBeDisabled()
  })

  it('holds the first step while the skillset list cannot be read, even with an older copy in hand', async () => {
    const clicker = userEvent.setup()
    app.skillsetsFailed = true
    app.skillsets = [{ id: 'github-com-acme-skills' }]
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-start'))
    await clicker.click(screen.getByTestId('team-brain-location-googledrive'))
    expect(screen.getByText('Couldn’t read this workspace’s skillsets.')).toBeInTheDocument()
    expect(screen.queryByTestId('team-brain-public-skillset-missing')).toBeNull()
    expect(screen.getByTestId('team-brain-next')).toBeDisabled()
    await clicker.click(screen.getByRole('button', { name: 'Try again' }))
    expect(app.rereadSkillsets).toHaveBeenCalled()
  })

  it('shows Team Brain’s home page once set up, for its agent', async () => {
    app.agents = [{ ...agent('team-brain'), teamBrain: { volumeId: 'vol-1' } }]
    render(<TeamBrainPage />)
    expect(await screen.findByTestId('team-brain-home')).toHaveTextContent('team-brain')
  })

  it('puts a drive set-up\u2019s buttons in the modal\u2019s own bar', async () => {
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-start'))
    await clicker.click(screen.getByTestId('team-brain-location-s3'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    const footer = await screen.findByTestId('team-brain-drive-footer')
    expect(within(footer).getByTestId('team-brain-back')).toBeInTheDocument()
    expect(within(footer).getByTestId('team-brain-drive-submit')).toHaveTextContent('Test connection')
    expect(within(screen.getByTestId('team-brain-drive-setup')).queryByRole('button', { name: 'Cancel' })).toBeNull()
    // Back returns to the homes.
    await clicker.click(within(footer).getByTestId('team-brain-back'))
    expect(screen.getByTestId('team-brain-location-s3')).toHaveAttribute('aria-checked', 'true')
  })


  it('leaves set-up to admins in a team workspace, and never reads an admin’s set-up', async () => {
    Object.assign(user, { isAuthMode: true, isAdmin: false })
    app.setup = SAVED
    render(<TeamBrainPage />)
    expect(await screen.findByTestId('team-brain-ask-admin')).toHaveTextContent('Ask an admin to set up Team Brain.')
    expect(screen.queryByTestId('team-brain-start')).toBeNull()
    expect(screen.queryByTestId('team-brain-resume')).toBeNull()
  })
})
