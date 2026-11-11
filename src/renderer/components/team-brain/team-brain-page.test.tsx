// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VolumeSetupProps } from '@renderer/components/volumes/volume-setup'
import type { TeamBrainSetup } from '@shared/lib/config/team-brain-schema'

const DRIVE = { accountId: 'acct', folderId: 'folder1', folderName: 'Brain', driveName: 'My Drive' }

// The set-up claim and the app's own routes, faked at the HTTP boundary and the mutation hooks; the hook, the page and
// the window run for real. Each call the page makes is logged in order.
const { app, user } = vi.hoisted(() => ({
  app: {
    calls: [] as string[],
    agentsPending: false,
    agents: [] as Array<{ slug: string; displaySlug: string; name: string; status: string; avatar: null; teamBrain?: { volumeId: string } }>,
    setup: null as TeamBrainSetup | null,
    /** Agents that exist, and each drive's attachments: what the claim names may be gone. */
    existing: new Set<string>(),
    attached: new Map<string, Set<string>>(),
    /** Agents whose sessions Team Brain reads: what an earlier Start chat gave. */
    reads: new Set<string>(),
    drives: 0,
    /** The next claim is answered as another admin's set-up would be: stale, with theirs saved. */
    otherAdmin: null as TeamBrainSetup | null,
    /** Another window records its own agent just before this one does. */
    otherWindowAgent: null as string | null,
    /** Another admin finished the set-up: the next save is refused as ready. */
    finishedElsewhere: false,
    readyFails: false,
    instructions: '',
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
const refused = (status: number, reason: string) => answer(status, { error: `refused: ${reason}`, reason })
const STEPS = ['location', 'agents', 'schedule', 'intake']

function viewOf(setup: TeamBrainSetup) {
  const agent = !!setup.agentSlug && app.existing.has(setup.agentSlug)
  return { setup, agent, drive: agent && !!setup.volumeId && !!app.attached.get(setup.volumeId)?.has(setup.agentSlug!) }
}

/** The claim's routes, answered as the server does. */
function claimRoute(method: string, url: string, body: Record<string, unknown>) {
  if (method === 'GET') return app.setup ? answer(200, viewOf(app.setup)) : refused(404, 'none')
  if (url.endsWith('/ready')) {
    app.calls.push('ready')
    if (app.readyFails) {
      app.readyFails = false
      return answer(500, { error: 'Team Brain set-up failed' })
    }
    const { agentSlug, volumeId } = app.setup!
    app.setup = null
    app.agents = [...app.agents, { slug: agentSlug!, displaySlug: agentSlug!, name: 'Team Brain', status: 'stopped', avatar: null, teamBrain: { volumeId: volumeId! } }]
    return answer(200, { agentSlug, volumeId, firstPrompt: 'Set up our team brain' })
  }
  if (method === 'POST') {
    app.calls.push('claim')
    if (app.otherAdmin) {
      app.setup = app.otherAdmin
      app.otherAdmin = null
    }
    if (app.setup) return refused(409, 'stale')
    app.setup = { status: 'setting-up', setupId: 's1', agentSlug: null, volumeId: null, location: null, step: 'location', schedule: 'daily', everyAgent: true, agents: {} }
    return answer(201, viewOf(app.setup))
  }
  if (method === 'DELETE') {
    app.calls.push('drop claim')
    if (!app.setup) return refused(404, 'discarded')
    const { agentSlug, volumeId } = app.setup
    app.setup = null
    return answer(200, { agentSlug, volumeId })
  }
  if (app.finishedElsewhere) return refused(409, 'ready')
  if (!app.setup) return refused(404, 'discarded')
  const { setupId, agent, drive, ...choices } = body as {
    setupId: string
    agent?: { slug: string | null; replaces: string | null }
    drive?: { volumeId: string | null; location: TeamBrainSetup['location']; replaces: string | null }
  } & Partial<TeamBrainSetup>
  if (setupId !== app.setup.setupId) return refused(409, 'stale')
  if (agent) {
    app.calls.push(`record agent ${agent.slug}`)
    if (app.otherWindowAgent) {
      app.existing.add(app.otherWindowAgent)
      app.setup = { ...app.setup, agentSlug: app.otherWindowAgent }
      app.otherWindowAgent = null
    }
    if (app.setup.agentSlug !== agent.replaces) return refused(409, 'changed')
  }
  if (drive) {
    app.calls.push(drive.volumeId ? `record drive ${drive.volumeId}` : `release drive ${drive.replaces}`)
    if (app.setup.volumeId !== drive.replaces) return refused(409, 'changed')
  }
  const saved = Object.entries(choices).filter(([key]) => key !== 'step' || !drive)
  if (saved.length > 0) app.calls.push(`save ${saved.map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(', ')}`)
  app.setup = {
    ...app.setup,
    ...choices,
    agents: { ...app.setup.agents, ...choices.agents },
    step: choices.step && STEPS.indexOf(choices.step) > STEPS.indexOf(app.setup.step) ? choices.step : app.setup.step,
    ...(agent ? { agentSlug: agent.slug } : {}),
    ...(drive ? { volumeId: drive.volumeId, location: drive.location } : {}),
  }
  return answer(200, viewOf(app.setup))
}

/** The app's own routes the set-up calls. */
function appRoute(method: string, url: string, body: Record<string, unknown>) {
  let match: RegExpMatchArray | null
  if ((match = url.match(/^\/api\/volume-definitions\/([^/]+)\/agents$/))) {
    const attached = app.attached.get(match[1])
    if (!attached) return answer(404, { error: 'Drive not found' })
    return answer(200, { attachments: [...attached].map((agentSlug) => ({ agentSlug, mountId: `m-${agentSlug}` })) })
  }
  if ((match = url.match(/^\/api\/volume-definitions\/([^/]+)$/)) && method === 'DELETE') {
    app.calls.push(`delete drive ${match[1]}`)
    app.attached.delete(match[1])
    return answer(200, { success: true })
  }
  if ((match = url.match(/^\/api\/agents\/([^/]+)\/mounts\/[^/]+$/)) && method === 'DELETE') {
    app.calls.push(`unmount ${match[1]}`)
    for (const agents of app.attached.values()) agents.delete(match[1])
    return answer(200, { success: true })
  }
  if ((match = url.match(/^\/api\/agents\/([^/]+)\/mounts$/))) {
    const slug = match[1]
    return answer(200, [...app.attached].filter(([, agents]) => agents.has(slug)).map(([volumeId]) => ({ volumeId, name: 'Team Brain' })))
  }
  if (url.match(/^\/api\/agents\/[^/]+\/x-agent-policies$/)) {
    return answer(200, { policies: [...app.reads].map((targetAgentSlug) => ({ operation: 'read', targetAgentSlug })) })
  }
  if (url.endsWith('/team-brain/upkeep')) {
    app.calls.push(`upkeep ${body.scheduleExpression}`)
    return answer(200, { taskId: 'task-1' })
  }
  if ((match = url.match(/^\/api\/agents\/([^/]+)$/))) {
    if (method !== 'DELETE') return answer(200, { slug: match[1], instructions: app.instructions })
    app.calls.push(`delete agent ${match[1]}`)
    app.existing.delete(match[1])
    for (const agents of app.attached.values()) agents.delete(match[1])
    return answer(204)
  }
  return answer(200, {})
}

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : {}
    return url.startsWith('/api/team-brain/setup') ? claimRoute(method, url, body) : appRoute(method, url, body)
  }),
}))
vi.mock('@renderer/hooks/use-agent-templates', async () => {
  const { DEFAULT_PUBLIC_SKILLSET } = await import('@shared/lib/skillset-provider/default-public-skillset')
  return {
    useDiscoverableAgents: () => ({ data: [{ skillsetId: DEFAULT_PUBLIC_SKILLSET.id, path: 'agents/team-brain/', name: 'Team Brain', version: '0.1.0' }] }),
    useInstallAgentFromSkillset: () => ({
      mutateAsync: async () => {
        app.calls.push('install')
        app.existing.add('team-brain')
        return { slug: 'team-brain' }
      },
    }),
  }
})
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: app.agentsPending ? undefined : app.agents, isPending: app.agentsPending }),
  useStartAgent: () => ({ mutate: app.startAgent }),
  useUpdateAgent: () => ({
    mutateAsync: async ({ instructions }: { instructions: string }) => {
      app.calls.push('instructions')
      app.instructions = instructions
    },
  }),
}))
vi.mock('@renderer/hooks/use-skillsets', () => ({
  useSkillsets: () => ({ data: app.skillsets, isError: app.skillsetsFailed, refetch: app.rereadSkillsets }),
  useAddSkillset: () => ({ mutateAsync: app.addSkillset }),
}))
vi.mock('@renderer/hooks/use-mounts', () => ({
  useAgentMounts: (slug: string) => ({
    data: slug && app.health !== 'loading'
      ? [...app.attached].filter(([, agents]) => agents.has(slug)).map(([volumeId]) => ({ id: `m-${slug}`, volumeId, health: app.health }))
      : undefined,
    isError: app.pollFailed,
    refetch: app.recheck,
  }),
  useAddMount: () => ({
    mutateAsync: async ({ agentSlug }: { agentSlug: string }) => {
      const volumeId = `vol${++app.drives}`
      app.calls.push(`make drive ${volumeId}`)
      app.attached.set(volumeId, new Set([agentSlug]))
      return { volumeId, name: 'Team Brain' }
    },
  }),
}))
vi.mock('@renderer/hooks/use-volume-definitions', () => ({
  useSaveVolumeDefinition: () => ({ mutateAsync: async ({ global }: { global: string | null }) => { app.calls.push(`global ${global ?? 'off'}`) } }),
}))
vi.mock('@renderer/hooks/use-team-brain-access', () => ({
  useGiveTeamBrain: () => async (slug: string, { mount }: { mount: boolean }) => { app.calls.push(`give ${slug}${mount ? ' +drive' : ''}`) },
  useTakeTeamBrain: () => async (slug: string, { mountId }: { mountId?: string }) => { app.calls.push(`take ${slug}${mountId ? ' -drive' : ''}`) },
  setTeamBrainReach: async (_client: unknown, _brain: string, operation: string, allowed: boolean) => { app.calls.push(`${operation} ${allowed ? 'on' : 'off'}`) },
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
/** A set-up left at Sync, with its agent holding its drive. */
const SAVED: TeamBrainSetup = {
  status: 'setting-up', setupId: 's1', agentSlug: 'team-brain', volumeId: 'vol1', location: 'googledrive',
  step: 'schedule', schedule: 'weekly', everyAgent: false, agents: { writer: true },
}
function leftAt(setup: TeamBrainSetup) {
  app.setup = setup
  app.existing.add('team-brain')
  app.attached.set('vol1', new Set(['team-brain']))
  app.drives = 1
}
/** The calls the page made, less the warm start a ready drive triggers. */
const made = () => app.calls.filter((call) => call !== 'warm-start')

let client: QueryClient
const invalidate = () => vi.spyOn(client, 'invalidateQueries')
function TeamBrainPage() {
  return <QueryClientProvider client={client}><Page /></QueryClientProvider>
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  resetTeamBrainState()
  Object.assign(app, {
    calls: [], agents: [agent('writer'), agent('planner')], setup: null, existing: new Set(), attached: new Map(), reads: new Set(), drives: 0,
    otherAdmin: null, otherWindowAgent: null, finishedElsewhere: false, readyFails: false,
    instructions: '- **Brain location:** `{{brain_path}}`\n- **Maintenance schedule:** `{{schedule}}`',
    health: 'ok', pollFailed: false, skillsets: [{ id: DEFAULT_PUBLIC_SKILLSET.id }], skillsetsFailed: false,
  })
  Object.assign(user, { isAuthMode: false, isAdmin: false })
})
afterEach(() => {
  cleanup()
  resetTeamBrainState()
  vi.clearAllMocks()
})

async function saveDrive(clicker: ReturnType<typeof userEvent.setup>, opener = 'team-brain-start') {
  await clicker.click(await screen.findByTestId(opener))
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

  it('claims before it makes anything, records the agent and the drive as each is made, and saves choices as they change', async () => {
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents'))
    expect(made()).toEqual(['claim', 'install', 'record agent team-brain', 'make drive vol1', 'record drive vol1'])
    await waitFor(() => expect(app.calls).toContain('warm-start'))
    expect(app.setup).toMatchObject({ agentSlug: 'team-brain', volumeId: 'vol1', location: 'googledrive', step: 'agents' })

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

  describe('coming back to a half set-up Team Brain', () => {
    it('resumes at the saved step with the saved choices, changing nothing', async () => {
      const clicker = userEvent.setup()
      leftAt(SAVED)
      render(<TeamBrainPage />)
      await clicker.click(await screen.findByTestId('team-brain-resume'))
      expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'schedule')
      expect(screen.getByTestId('team-brain-schedule-weekly')).toHaveAttribute('aria-checked', 'true')
      await clicker.click(screen.getByTestId('team-brain-back'))
      expect(screen.getByTestId('team-brain-agent-writer')).toBeChecked()
      expect(screen.getByTestId('team-brain-agent-planner')).not.toBeChecked()
      expect(made()).toEqual([])
    })

    it('a claim with nothing made yet resumes at where it lives, and saving the drive continues the same set-up', async () => {
      const clicker = userEvent.setup()
      app.setup = { ...SAVED, agentSlug: null, volumeId: null, location: null, step: 'location' }
      render(<TeamBrainPage />)
      await saveDrive(clicker, 'team-brain-resume')
      await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents'))
      expect(made()).toEqual(['install', 'record agent team-brain', 'make drive vol1', 'record drive vol1'])
      expect(app.setup).toMatchObject({ setupId: 's1', schedule: 'weekly', agents: { writer: true } })
    })

    it('a drive removed since resumes at where it lives, and a new drive replaces it on the same agent', async () => {
      const clicker = userEvent.setup()
      leftAt(SAVED)
      app.attached.get('vol1')!.clear()
      render(<TeamBrainPage />)
      await clicker.click(await screen.findByTestId('team-brain-resume'))
      expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'location')
      // The old location is chosen, but its drive is gone: Next sets one up again rather than going on.
      expect(screen.getByTestId('team-brain-location-googledrive')).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByTestId('team-brain-next')).toHaveTextContent('Next: Set up Google Drive')
      await clicker.click(screen.getByTestId('team-brain-next'))
      await clicker.click(screen.getByTestId('drive-save'))
      await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents'))
      expect(made()).toEqual(['release drive vol1', 'delete drive vol1', 'make drive vol2', 'record drive vol2'])
      expect(app.setup).toMatchObject({ agentSlug: 'team-brain', volumeId: 'vol2', step: 'schedule' })
    })

    it('an agent deleted since resumes at where it lives, and installs a new one in its place', async () => {
      const clicker = userEvent.setup()
      leftAt(SAVED)
      app.existing.clear()
      app.attached.get('vol1')!.clear()
      render(<TeamBrainPage />)
      await saveDrive(clicker, 'team-brain-resume')
      await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents'))
      expect(made()).toEqual(['install', 'record agent team-brain', 'release drive vol1', 'delete drive vol1', 'make drive vol2', 'record drive vol2'])
    })

    it('a window whose drive goes while it is open goes back to where it lives', async () => {
      const clicker = userEvent.setup()
      leftAt({ ...SAVED, step: 'intake' })
      render(<TeamBrainPage />)
      await clicker.click(await screen.findByTestId('team-brain-resume'))
      app.attached.get('vol1')!.clear()
      app.readyFails = false
      await clicker.click(screen.getByTestId('team-brain-start-chat'))
      // Its Start chat fails on the missing drive, and the window reads the set-up again.
      await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'location'))
    })

    it('a Start chat that failed part-way runs again whole, and lands on choices changed since', async () => {
      const clicker = userEvent.setup()
      leftAt({ ...SAVED, step: 'intake' })
      render(<TeamBrainPage />)
      await clicker.click(await screen.findByTestId('team-brain-resume'))
      app.readyFails = true
      await clicker.click(screen.getByTestId('team-brain-start-chat'))
      await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not start Team Brain', expect.anything()))
      expect(app.setup).toMatchObject({ status: 'setting-up' })
      expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'intake')
      // What the first run gave the writer, as the drive and the policies now say.
      app.attached.get('vol1')!.add('writer')
      app.reads.add('writer')

      // Writer off, planner on, daily: the second run takes the writer's back and fills the new schedule over the old.
      await clicker.click(screen.getByTestId('team-brain-back'))
      await clicker.click(screen.getByTestId('team-brain-schedule-daily'))
      await clicker.click(screen.getByTestId('team-brain-back'))
      await clicker.click(screen.getByTestId('team-brain-agent-writer'))
      await clicker.click(screen.getByTestId('team-brain-agent-planner'))
      await clicker.click(screen.getByTestId('team-brain-next'))
      await clicker.click(screen.getByTestId('team-brain-next'))
      app.calls.length = 0
      await clicker.click(screen.getByTestId('team-brain-start-chat'))
      await waitFor(() => expect(app.calls).toContain('session'))
      expect(made()).toEqual([
        'global off', 'upkeep 0 0 * * *', 'list on', 'read off', 'give planner +drive', 'take writer -drive', 'instructions', 'ready', 'session',
      ])
      expect(app.instructions).toContain('daily at midnight')
      expect(app.instructions).not.toContain('weekly')
    })
  })

  it('discards after a confirm: the claim goes first, then its agent and drive, and the pitch goes back to Set up', async () => {
    const clicker = userEvent.setup()
    leftAt(SAVED)
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-discard'))
    expect(screen.getByText('Discard Team Brain set-up?')).toBeInTheDocument()
    expect(screen.getByText(/The Team Brain agent and drive made so far will be removed/)).toBeInTheDocument()
    await clicker.click(screen.getByTestId('team-brain-discard-confirm'))
    await waitFor(() => expect(screen.getByTestId('team-brain-start')).toBeInTheDocument())
    expect(made()).toEqual(['drop claim', 'delete agent team-brain', 'delete drive vol1'])
  })

  it('switches to the set-up another admin claimed first, and says so', async () => {
    const clicker = userEvent.setup()
    app.otherAdmin = { ...SAVED, setupId: 's2', step: 'agents' }
    app.existing.add('team-brain')
    app.attached.set('vol1', new Set(['team-brain']))
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents'))
    expect(made()).toEqual(['claim'])
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('A Team Brain set-up was already started. You’re continuing it.')
  })

  it('removes the agent it just installed when another window recorded one first', async () => {
    const clicker = userEvent.setup()
    app.otherWindowAgent = 'their-brain'
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(made()).toContain('delete agent team-brain'))
    expect(made()).not.toContain('make drive vol1')
    expect(app.setup?.agentSlug).toBe('their-brain')
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Team Brain set-up changed in another window. This shows it as it is now.')
  })

  it('closes when its set-up was discarded by another admin, and says so', async () => {
    const clicker = userEvent.setup()
    leftAt(SAVED)
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-resume'))
    app.setup = null
    await clicker.click(screen.getByTestId('team-brain-schedule-daily'))
    await waitFor(() => expect(screen.queryByTestId('team-brain-onboarding')).toBeNull())
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Team Brain set-up was discarded.')
  })

  it('closes when another admin finished the set-up, and says so', async () => {
    const clicker = userEvent.setup()
    leftAt(SAVED)
    render(<TeamBrainPage />)
    await clicker.click(await screen.findByTestId('team-brain-resume'))
    app.finishedElsewhere = true
    await clicker.click(screen.getByTestId('team-brain-schedule-daily'))
    await waitFor(() => expect(screen.queryByTestId('team-brain-onboarding')).toBeNull())
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Team Brain was set up from another window.')
  })

  it('starts the agent once its drive has copied, and offers Start chat only then', async () => {
    const clicker = userEvent.setup()
    app.health = 'preparing'
    leftAt({ ...SAVED, step: 'intake' })
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

  it('Start chat sets everything up through the app’s routes, marks it ready last, then opens the first chat', async () => {
    const clicker = userEvent.setup()
    leftAt({ ...SAVED, step: 'intake' })
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
    // Members get Team Brain at ready, after its upkeep and agents are set up.
    expect(made()).toEqual(['global off', 'upkeep 0 0 * * 1', 'list on', 'read off', 'give writer +drive', 'instructions', 'ready', 'session'])
    expect(app.instructions).toBe('- **Brain location:** `/mounts/Team Brain`\n- **Maintenance schedule:** weekly, Mondays at midnight (cron `0 0 * * 1`)')
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

  it('puts a drive set-up’s buttons in the modal’s own bar', async () => {
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
    leftAt(SAVED)
    render(<TeamBrainPage />)
    expect(await screen.findByTestId('team-brain-ask-admin')).toHaveTextContent('Ask an admin to set up Team Brain.')
    expect(screen.queryByTestId('team-brain-start')).toBeNull()
    expect(screen.queryByTestId('team-brain-resume')).toBeNull()
  })
})
