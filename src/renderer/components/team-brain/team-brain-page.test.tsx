// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { VolumeSetupProps } from '@renderer/components/volumes/volume-setup'

const DRIVE = { accountId: 'acct', folderId: 'folder1', folderName: 'Brain', driveName: 'My Drive' }

// The app's own calls, each recorded in order; the set-up hook and the page run for real.
const { app, user } = vi.hoisted(() => {
  const calls: string[] = []
  const record = <T,>(name: string, result?: T) => vi.fn(async () => {
    calls.push(name)
    return result
  })
  return {
    app: {
      calls,
      agentsPending: false,
      agents: [] as Array<{ slug: string; displaySlug: string; name: string; status: string; avatar: null; teamBrain?: { volumeId: string } }>,
      instructions: '',
      record: undefined as { agentSlug: string; volumeId: string } | undefined,
      upkeepFails: false as boolean | 'rejects',
      /** The prepared drive's health: 'preparing' while its first copy runs; or the drive list not in yet. */
      health: 'ok' as 'ok' | 'preparing' | 'missing' | 'loading',
      /** The drive list's last poll failed, over what it said before. */
      pollFailed: false,
      recheck: vi.fn(async () => {}),
      install: record('install', { slug: 'team-brain', onboardingFirstPrompt: 'Set up our team brain' }),
      addMount: vi.fn(async ({ agentSlug, readOnly }: { agentSlug: string; readOnly?: boolean }) => {
        calls.push(`mount ${agentSlug}${readOnly ? ' read-only' : ''}`)
        return { id: `m-${agentSlug}`, volumeId: 'vol1', name: 'Team Brain' }
      }),
      startAgent: vi.fn(() => { calls.push('warm-start') }),
      deleteAgent: vi.fn(async (slug: string) => { calls.push(`delete agent ${slug}`) }),
      deleteVolume: vi.fn(async (id: string) => { calls.push(`delete drive ${id}`) }),
      saveVolume: vi.fn(async ({ global }: { global: string }) => { calls.push(`global ${global}`) }),
      updateAgent: vi.fn(async ({ instructions }: { instructions: string }) => { calls.push('instructions'); app.instructions = instructions }),
      updateSettings: record('record'),
      invalidate: record('refresh agents'),
      session: vi.fn(async () => { calls.push('session') }),
    },
    user: { isAuthMode: false, isAdmin: false },
  }
})
vi.mock('@renderer/hooks/use-agent-templates', async () => {
  const { DEFAULT_PUBLIC_SKILLSET } = await import('@shared/lib/skillset-provider/default-public-skillset')
  return {
    useDiscoverableAgents: () => ({ data: [{ skillsetId: DEFAULT_PUBLIC_SKILLSET.id, path: 'agents/team-brain/', name: 'Team Brain', version: '0.1.0' }] }),
    useInstallAgentFromSkillset: () => ({ mutateAsync: app.install }),
  }
})
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: app.agentsPending ? undefined : app.agents, isPending: app.agentsPending }),
  useDeleteAgent: () => ({ mutateAsync: app.deleteAgent }),
  useStartAgent: () => ({ mutate: app.startAgent }),
  useUpdateAgent: () => ({ mutateAsync: app.updateAgent }),
}))
vi.mock('@renderer/hooks/use-mounts', () => ({
  useAgentMounts: (slug: string) => ({
    data: slug && app.health !== 'loading' ? [{ id: `m-${slug}`, volumeId: 'vol1', health: app.health }] : undefined,
    isError: app.pollFailed,
    refetch: app.recheck,
  }),
  useAddMount: () => ({ mutateAsync: app.addMount }),
}))
vi.mock('@renderer/hooks/use-volume-definitions', () => ({
  useDeleteVolumeDefinition: () => ({ mutateAsync: app.deleteVolume }),
  useSaveVolumeDefinition: () => ({ mutateAsync: app.saveVolume }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ refetch: async () => ({ data: { teamBrain: app.record } }) }),
  useUpdateSettings: () => ({ mutateAsync: app.updateSettings }),
}))
vi.mock('@renderer/hooks/use-start-onboarding-session', () => ({ useStartOnboardingSession: () => app.session }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({ useConnectedAccounts: () => ({ data: undefined }) }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: app.invalidate }) }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    // Grants are logged once they land, so the order against the session shows set-up waited for them.
    if (init?.method === 'PUT' || init?.method === 'PATCH') await new Promise((resolve) => setTimeout(resolve, 0))
    if (init?.method === 'PUT') app.calls.push(url.includes('/read/') ? `read ${url.split('/').pop()}` : `grant ${url.split('/')[3]}`)
    if (init?.method === 'PATCH') app.calls.push(`${JSON.parse(init.body ?? '{}').operation} all`)
    if (url.endsWith('/team-brain/upkeep')) {
      app.calls.push(`upkeep ${JSON.parse(init?.body ?? '{}').scheduleExpression}`)
      if (app.upkeepFails === 'rejects') throw new Error('Network down')
      if (app.upkeepFails) return { ok: false, json: async () => ({}) }
    }
    return { ok: true, json: async () => ({ instructions: 'Brain: `{{brain_path}}`. Schedule: `{{schedule}}`.' }) }
  }),
}))
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
import { TeamBrainPage } from './team-brain-page'
import { volumeSetupRegistry } from '@renderer/components/volumes/volume-setup-registry'
import { getTeamBrainState, resetTeamBrainState } from '@renderer/lib/team-brain/team-brain-store'
import { TEAM_BRAIN_INITIAL_STATE } from '@renderer/lib/team-brain/team-brain-schema'

const agent = (slug: string) => ({ slug, displaySlug: slug, name: slug[0].toUpperCase() + slug.slice(1), status: 'stopped', avatar: null })

beforeEach(() => {
  resetTeamBrainState()
  app.calls.length = 0
  app.agents = [agent('writer'), agent('planner')]
  app.record = undefined
  app.upkeepFails = false
  app.health = 'ok'
  app.pollFailed = false
  Object.assign(user, { isAuthMode: false, isAdmin: false })
})
afterEach(() => {
  cleanup()
  resetTeamBrainState()
  vi.clearAllMocks()
})

async function saveDrive(clicker: ReturnType<typeof userEvent.setup>) {
  await clicker.click(screen.getByTestId('team-brain-start'))
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

  it('opens on the pitch, and Set up opens the modal at where it lives with nothing chosen', async () => {
    render(<TeamBrainPage />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('One source of truth for every agent.')

    await userEvent.click(screen.getByTestId('team-brain-start'))
    expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'location')
    // Every drive type the drives offer, Google Drive and Dropbox first, then the rest in the drives' own order.
    const homes = screen.getAllByTestId(/^team-brain-location-/)
    const rest = Object.values(volumeSetupRegistry).map((drive) => drive.type).filter((id) => id !== 'googledrive' && id !== 'dropbox')
    expect(homes.map((home) => home.dataset.testid)).toEqual(['googledrive', 'dropbox', ...rest].map((id) => `team-brain-location-${id}`))
    for (const home of homes) expect(home).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('team-brain-next')).toBeDisabled()
  })

  it('prepares on the saved drive, and launches in order: instructions, record, upkeep, agent list, the chosen agents, then the session', async () => {
    const clicker = userEvent.setup()
    // The record marks the agent once the agent list refreshes.
    app.invalidate.mockImplementationOnce(async () => {
      app.calls.push('refresh agents')
      app.agents = [...app.agents, { ...agent('team-brain'), teamBrain: { volumeId: 'vol-1' } }]
    })
    const page = render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents'))
    expect(app.calls).toEqual(['install', 'mount team-brain', 'warm-start'])

    // Every agent off, then planner off, weekly.
    await clicker.click(screen.getByTestId('team-brain-every-agent-switch'))
    await clicker.click(screen.getByTestId('team-brain-agent-planner'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-schedule-weekly'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    app.session.mockImplementationOnce(async () => {
      // Under the "Setting up your agent..." card the page is blank: no modal, no pitch.
      expect(screen.queryByTestId('team-brain-onboarding')).toBeNull()
      expect(screen.queryByTestId('team-brain-intro')).toBeNull()
      app.calls.push('session')
    })
    await clicker.click(screen.getByTestId('team-brain-start-chat'))
    await waitFor(() => expect(app.calls).toContain('session'))

    const launch = app.calls.slice(3)
    expect(launch.slice(0, 4)).toEqual(['instructions', 'record', 'upkeep 0 0 * * 1', 'refresh agents'])
    expect(launch).toEqual(expect.arrayContaining(['mount writer read-only', 'grant writer', 'read writer', 'list all', 'session']))
    expect(launch.some((call) => call.endsWith('planner') || call === 'read all')).toBe(false)
    // Team Brain can list and read the chosen agents before its first chat starts.
    expect(Math.max(launch.indexOf('list all'), launch.indexOf('read writer'))).toBeLessThan(launch.indexOf('session'))
    expect(app.instructions).toBe('Brain: `/mounts/Team Brain`. Schedule: weekly, Mondays at midnight (cron `0 0 * * 1`).')

    // Set-up is over once launched: with no session to replace it, the page shows Team Brain's home page.
    expect(getTeamBrainState()).toEqual(TEAM_BRAIN_INITIAL_STATE)
    page.rerender(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-home')).toBeInTheDocument()
  })

  it('starts the agent once its drive has copied, and offers Start chat only then', async () => {
    const clicker = userEvent.setup()
    app.health = 'preparing'
    const page = render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'agents'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    // Started now, the agent would run without the drive it is about to build.
    expect(app.calls).toEqual(['install', 'mount team-brain'])
    expect(screen.getByTestId('team-brain-start-chat')).toBeDisabled()
    expect(screen.getByTestId('team-brain-start-chat')).toHaveTextContent('Copying the drive…')

    // Not known yet is not ready, and says nothing it doesn't know.
    app.health = 'loading'
    page.rerender(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-start-chat')).toBeDisabled()
    expect(screen.getByTestId('team-brain-start-chat')).toHaveTextContent('Start chat')

    // A poll that fails after one that said copying may be out of date: still not ready.
    app.health = 'preparing'
    app.pollFailed = true
    page.rerender(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-start-chat')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t check the drive.')
    // Try again reads the drive list again.
    await clicker.click(screen.getByRole('button', { name: 'Try again' }))
    expect(app.recheck).toHaveBeenCalled()
    app.pollFailed = false

    app.health = 'missing'
    page.rerender(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-start-chat')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t read the drive.')

    app.health = 'ok'
    page.rerender(<TeamBrainPage />)
    expect(app.calls).toEqual(['install', 'mount team-brain', 'warm-start'])
    expect(screen.getByTestId('team-brain-start-chat')).toBeEnabled()
    expect(screen.getByTestId('team-brain-start-chat')).toHaveTextContent('Start chat')
  })

  it('starts on every agent: the drive goes global once the record is accepted, each agent can message Team Brain, and Team Brain reads every agent', async () => {
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(screen.getByTestId('team-brain-every-agent-switch')).toBeChecked())
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-start-chat'))
    await waitFor(() => expect(app.calls).toContain('session'))

    expect(app.calls.indexOf('global read')).toBeGreaterThan(app.calls.indexOf('record'))
    expect(app.calls).toEqual(expect.arrayContaining(['grant writer', 'grant planner', 'list all', 'read all']))
    expect(Math.max(app.calls.indexOf('list all'), app.calls.indexOf('read all'))).toBeLessThan(app.calls.indexOf('session'))
    expect(app.calls).not.toContain('mount writer')
  })

  it('discards its own draft when another admin\'s set-up took the record first, and publishes nothing', async () => {
    app.updateSettings.mockImplementationOnce(async () => {
      app.calls.push('record')
      throw { error: 'Team Brain is already set up', status: 409 }
    })
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(screen.getByTestId('team-brain-every-agent-switch')).toBeChecked())
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-start-chat'))
    await waitFor(() => expect(app.calls).toContain('delete drive vol1'))

    expect(app.calls.slice(app.calls.indexOf('record'))).toEqual(['record', 'delete agent team-brain', 'delete drive vol1', 'refresh agents'])
    expect(toast.info).toHaveBeenCalled()
    expect(getTeamBrainState()).toEqual(TEAM_BRAIN_INITIAL_STATE)
  })

  it('deletes nothing when the record write fails for another reason, since the record may have been saved', async () => {
    app.updateSettings.mockRejectedValueOnce({ error: 'Failed to update settings', status: 500 })
    const clicker = userEvent.setup()
    const page = render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(getTeamBrainState().prepared).not.toBeNull())
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-start-chat'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())

    // The record may have been saved, so nothing is deleted, now or when the page is left.
    expect(getTeamBrainState()).toEqual(TEAM_BRAIN_INITIAL_STATE)
    page.unmount()
    expect(app.calls.some((call) => call.startsWith('delete'))).toBe(false)
  })

  it('deletes the installed agent when its drive cannot be made, and stays on where it lives', async () => {
    app.addMount.mockRejectedValueOnce(new Error('Drive not found'))
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await saveDrive(clicker)

    expect(await screen.findByRole('alert')).toHaveTextContent('Drive not found')
    expect(app.calls).toEqual(['install', 'delete agent team-brain'])
    expect(getTeamBrainState()).toMatchObject({ prepared: null, installing: null, step: 'location' })
  })

  it('discards what was prepared on cancel, and when the page is left mid-way, but not after Start chat', async () => {
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(getTeamBrainState().prepared).not.toBeNull())
    await clicker.click(screen.getByTestId('team-brain-cancel'))
    await clicker.click(await screen.findByTestId('team-brain-cancel-confirm'))
    await waitFor(() => expect(app.calls).toContain('delete drive vol1'))
    expect(getTeamBrainState()).toEqual(TEAM_BRAIN_INITIAL_STATE)
    cleanup()

    app.calls.length = 0
    const left = render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(getTeamBrainState().prepared).not.toBeNull())
    left.unmount()
    await waitFor(() => expect(app.calls).toContain('delete drive vol1'))

    app.calls.length = 0
    // Start chat opens the session, which unmounts the page mid-launch.
    app.session.mockImplementationOnce(async () => { app.calls.push('session'); launched.unmount() })
    const launched = render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(getTeamBrainState().prepared).not.toBeNull())
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-start-chat'))
    await waitFor(() => expect(app.calls).toContain('session'))
    expect(app.calls.some((call) => call.startsWith('delete'))).toBe(false)
  })

  it.each([true, 'rejects'] as const)('keeps a recorded Team Brain when its upkeep cannot be scheduled (%s), and says so', async (fails) => {
    app.upkeepFails = fails
    const clicker = userEvent.setup()
    const page = render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(getTeamBrainState().prepared).not.toBeNull())
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-start-chat'))
    await waitFor(() => expect(app.calls).toContain('session'))
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not schedule Brain upkeep', expect.anything())
    page.unmount()
    expect(app.calls.some((call) => call.startsWith('delete'))).toBe(false)
  })

  it('refuses set-up when the workspace record names a Team Brain this admin cannot see', async () => {
    app.record = { agentSlug: 'brain-of-another-admin', volumeId: 'vol-9' }
    render(<TeamBrainPage />)
    await saveDrive(userEvent.setup())
    expect(await screen.findByRole('alert')).toHaveTextContent('Team Brain is already set up.')
    expect(app.calls).toEqual([])
  })

  it('deletes an agent whose install finished after set-up was left', async () => {
    app.install.mockImplementationOnce(async () => {
      app.calls.push('install')
      page.unmount()
      return { slug: 'team-brain', onboardingFirstPrompt: 'Set up our team brain' }
    })
    const page = render(<TeamBrainPage />)
    await saveDrive(userEvent.setup())
    await waitFor(() => expect(app.calls).toEqual(['install', 'delete agent team-brain']))
    expect(getTeamBrainState()).toMatchObject({ status: 'off', prepared: null, installing: null })
  })

  it('shows Team Brain’s home page once set up, for its agent', () => {
    app.agents = [{ ...agent('team-brain'), teamBrain: { volumeId: 'vol-1' } }]
    render(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-home')).toHaveTextContent('team-brain')
  })

  it('puts a drive set-up\u2019s buttons in the modal\u2019s own bar', async () => {
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await clicker.click(screen.getByTestId('team-brain-start'))
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

  it('leaves set-up to admins in a team workspace', () => {
    Object.assign(user, { isAuthMode: true, isAdmin: false })
    render(<TeamBrainPage />)
    expect(screen.queryByTestId('team-brain-start')).toBeNull()
    expect(screen.getByTestId('team-brain-ask-admin')).toHaveTextContent('Ask an admin to set up Team Brain.')
  })
})
