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
    if (init?.method === 'PUT') app.calls.push(`grant ${url.split('/')[3]}`)
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
// On the desktop set-up first asks how; the cloud's Team Brain is still being looked for. Its steps have their own tests.
const { desktop } = vi.hoisted(() => ({ desktop: { on: false } }))
vi.mock('@renderer/hooks/use-cloud-team-brain', () => ({
  useOffersCloudTeamBrain: () => desktop.on,
  useCloudTeamBrain: () => ({ state: 'checking', checkAgain: () => {} }),
}))
vi.mock('@renderer/hooks/use-target-switch', () => ({ useTargetSwitch: () => ({ switching: false, switchTo: vi.fn() }) }))
vi.mock('@renderer/context/dialog-context', () => ({ useDialogs: () => ({ openSettings: vi.fn() }) }))
// The home page has its own tests; here it only needs to show up, for the right agent.
vi.mock('./team-brain-overview', () => ({
  TeamBrainOverview: ({ agent }: { agent: { slug: string } }) => <div data-testid="team-brain-home">{agent.slug}</div>,
  TeamBrainCloudOverview: ({ brain }: { brain: { workspace: string } }) => <div data-testid="team-brain-cloud-home">{brain.workspace}</div>,
}))
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
import { resetCloudConnection, setCloudConnection } from '@renderer/lib/team-brain/team-brain-cloud'
import { cloudTeamBrain } from '@renderer/lib/team-brain/team-brain-cloud-fixture'

const agent = (slug: string) => ({ slug, displaySlug: slug, name: slug[0].toUpperCase() + slug.slice(1), status: 'stopped', avatar: null })

beforeEach(() => {
  resetTeamBrainState()
  resetCloudConnection()
  desktop.on = false
  app.calls.length = 0
  app.agents = [agent('writer'), agent('planner')]
  app.record = undefined
  app.upkeepFails = false
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

  it('prepares on the saved drive, and launches in order: instructions, record, upkeep, agent list, session, then the chosen agents', async () => {
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

    // Planner off, weekly.
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
    expect(launch).toEqual(expect.arrayContaining(['mount writer read-only', 'grant writer', 'session']))
    expect(launch.some((call) => call.endsWith('planner'))).toBe(false)
    expect(app.instructions).toBe('Brain: `/mounts/Team Brain`. Schedule: weekly, Mondays at midnight (cron `0 0 * * 1`).')

    // Set-up is over once launched: with no session to replace it, the page shows Team Brain's home page.
    expect(getTeamBrainState()).toEqual(TEAM_BRAIN_INITIAL_STATE)
    page.rerender(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-home')).toBeInTheDocument()
  })

  it('makes the drive global for every agent once the record is accepted, and still lets each one message Team Brain', async () => {
    const clicker = userEvent.setup()
    render(<TeamBrainPage />)
    await saveDrive(clicker)
    await waitFor(() => expect(screen.getByTestId('team-brain-every-agent-switch')).toBeEnabled())
    await clicker.click(screen.getByTestId('team-brain-every-agent-switch'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-next'))
    await clicker.click(screen.getByTestId('team-brain-start-chat'))
    await waitFor(() => expect(app.calls).toContain('session'))

    expect(app.calls.indexOf('global read')).toBeGreaterThan(app.calls.indexOf('record'))
    expect(app.calls).toEqual(expect.arrayContaining(['grant writer', 'grant planner']))
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
    await waitFor(() => expect(screen.getByTestId('team-brain-every-agent-switch')).toBeEnabled())
    await clicker.click(screen.getByTestId('team-brain-every-agent-switch'))
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

  it('on the desktop, one Set up opens set-up at how', async () => {
    desktop.on = true
    render(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-start')).toHaveTextContent('Set up Team Brain')
    await userEvent.click(screen.getByTestId('team-brain-start'))
    expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'how')
  })

  it('on the desktop, shows the cloud’s Team Brain’s home once connected', () => {
    desktop.on = true
    setCloudConnection({ connected: { brain: cloudTeamBrain('acme.gamut.cloud'), at: new Date().toISOString() }, agents: {}, everyAgent: false })
    render(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-cloud-home')).toHaveTextContent('acme.gamut.cloud')
  })

  it('on the desktop, keeps the home page of a Team Brain set up here before', () => {
    desktop.on = true
    app.agents = [agent('writer'), { ...agent('team-brain'), teamBrain: { volumeId: 'vol-1' } }]
    render(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-home')).toHaveTextContent('team-brain')
  })
})
