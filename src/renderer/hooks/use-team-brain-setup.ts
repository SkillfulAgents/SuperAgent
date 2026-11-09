import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useOnboarding } from '@renderer/context/onboarding-context'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import type { VolumeDetails } from '@renderer/components/volumes/volume-details-schema'
import { TEAM_BRAIN_STEPS, type TeamBrainChoices, type TeamBrainSetup, type TeamBrainStep } from '@shared/lib/config/team-brain-schema'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import { setUpByOf } from '@shared/lib/team-brain/team-brain-setup-block'
import type { MountSummaryWithHealth } from '@shared/lib/types/mount'
import type { VolumeSource } from '@shared/lib/volumes/volume-config-schema'
import { useStartAgent } from './use-agents'
import { useConnectedAccounts } from './use-connected-accounts'
import { usePlatformAuthStatus } from './use-platform-auth'
import { useAgentMounts } from './use-mounts'
import { useStartOnboardingSession } from './use-start-onboarding-session'
import { useAddSkillset } from './use-skillsets'

/** The set-up in progress, as `GET /api/team-brain/setup` answers. */
export interface TeamBrainSetupView {
  setup: TeamBrainSetup
}

const SETUP_KEY = ['team-brain-setup']

/** Choices before the first save, as the server claims a set-up with. */
const FIRST_CHOICES: TeamBrainChoices = { step: 'location', schedule: 'daily', everyAgent: true, agents: {} }

/** A refused set-up request, with the server's reason and the set-up it holds instead. */
class SetupRefusal extends Error {
  constructor(message: string, readonly reason: string | undefined, readonly setup: TeamBrainSetup | null) {
    super(message)
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`/api/team-brain/setup${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (res.ok) return res.status === 204 ? (undefined as T) : res.json()
  const answer = await res.json().catch(() => ({}))
  throw new SetupRefusal(answer.error ?? 'Team Brain set-up failed', answer.reason, answer.setup ?? null)
}

/**
 * Team Brain set-up for the page that hosts the window. The set-up lives on
 * the server: step 1 claims it and makes the agent and drive into it, choices
 * save as they change, and Start chat finishes it. Closing the window or
 * leaving the page keeps it; Discard removes it.
 */
export function useTeamBrainSetup() {
  const tb = useTeamBrain()
  const { setOnboarding } = useOnboarding()
  const { user, isAuthMode, isAdmin } = useUser()
  const canSetUp = !isAuthMode || isAdmin
  const { data: platform } = usePlatformAuthStatus()
  const { data: connected } = useConnectedAccounts()
  const queryClient = useQueryClient()
  const startAgent = useStartAgent()
  const addSkillset = useAddSkillset()
  const startOnboardingSession = useStartOnboardingSession()

  // Focus reads it again for the page, not under an open window: a set-up gone meanwhile surfaces as the refusal of its next save.
  const query = useQuery({
    queryKey: SETUP_KEY,
    enabled: canSetUp,
    refetchOnWindowFocus: !tb.isOnboarding,
    queryFn: async (): Promise<TeamBrainSetupView | null> => {
      const res = await apiFetch('/api/team-brain/setup')
      if (res.status === 404) return null
      if (!res.ok) throw new Error('Could not read Team Brain set-up')
      return res.json()
    },
  })
  const view = query.data ?? null
  const setup = view?.setup ?? null
  const showSetup = (next: TeamBrainSetup | null) => {
    // A new or reattached drive keeps the agent: read its drives again, or the old drive's health stays on show.
    if (next?.agentSlug && next.volumeId !== queryClient.getQueryData<TeamBrainSetupView | null>(SETUP_KEY)?.setup.volumeId) {
      void queryClient.invalidateQueries({ queryKey: ['mounts'] })
    }
    const data: TeamBrainSetupView | null = next ? { setup: next } : null
    queryClient.setQueryData(SETUP_KEY, data)
  }

  // A start mounts only drives that are ready, so a drive still making its first copy waits for the agent's start.
  const driveHealth = usePreparedDriveHealth(setup).health
  const warmed = useRef<string | null>(null)
  const warm = startAgent.mutate
  const agentSlug = setup?.agentSlug
  useEffect(() => {
    if (!tb.isOnboarding || !agentSlug || driveHealth !== 'ok' || warmed.current === agentSlug) return
    warmed.current = agentSlug
    warm({ slug: agentSlug, source: 'warm-start' }, {
      onError: (error) => captureRendererException(error, { tags: { area: 'team-brain', op: 'warm-start' } }),
    })
  }, [tb.isOnboarding, agentSlug, driveHealth, warm])

  /** A refusal that names what happened instead: another admin's set-up, none any more, or a Team Brain finished meanwhile. Others show as errors. */
  const settle = (error: unknown): boolean => {
    if (!(error instanceof SetupRefusal)) return false
    if (error.reason === 'stale' && error.setup) {
      showSetup(error.setup)
      tb.open(error.setup.step)
      toast.info('Another admin already started setting up Team Brain. You’re continuing it.')
      return true
    }
    if (error.reason === 'ready') {
      showSetup(null)
      tb.close()
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      toast.info('Another admin finished setting up Team Brain.')
      return true
    }
    if (error.reason === 'discarded') {
      showSetup(null)
      tb.close()
      toast.info('Team Brain set-up was discarded.')
      return true
    }
    return false
  }

  /** Step 1: claim the set-up and make its drive. False when the window now shows another set-up instead. */
  const prepare = async (source: VolumeSource, details: VolumeDetails): Promise<boolean> => {
    try {
      const { setup: next } = await send<{ setup: TeamBrainSetup }>('POST', '', { setupId: setup?.setupId ?? null, drive: { source, details } })
      showSetup(next)
      if (!view) void query.refetch()
      return true
    } catch (error) {
      // A failure after the claim leaves the claim: read it, so a retry continues it.
      void query.refetch()
      if (settle(error)) return false
      throw error
    }
  }

  /** Save a change as it is made (F4). The window shows it at once. */
  // Saves go one after another, and Start chat waits for the last: Finish must apply every choice made before it.
  const saves = useRef<Promise<boolean>>(Promise.resolve(true))
  const choose = (changes: Partial<TeamBrainChoices>) => {
    if (!setup) return
    showSetup({ ...setup, ...changes, agents: { ...setup.agents, ...changes.agents } })
    const { setupId } = setup
    saves.current = saves.current.then(() => send<{ setup: TeamBrainSetup }>('PATCH', '', { setupId, ...changes }))
      .then(({ setup: next }) => {
        showSetup(next)
        return true
      }, (error: unknown) => {
        if (settle(error)) return false
        toast.error('Could not save Team Brain set-up', { description: error instanceof Error ? error.message : undefined })
        // What the server holds is what Finish applies: show it and let Start chat go on.
        return query.refetch().then(() => true)
      })
  }

  /** Next: show the step, and save it when it is further than any reached. Back only shows it. */
  const goForward = (step: TeamBrainStep) => {
    tb.goToStep(step)
    if (setup && TEAM_BRAIN_STEPS.indexOf(step) > TEAM_BRAIN_STEPS.indexOf(setup.step)) choose({ step })
  }

  const start = () => tb.open('location')

  /** Resume at the saved step, with the saved choices. */
  const resume = () => {
    if (setup) tb.open(setup.step)
  }

  const discard = async () => {
    if (!setup) return
    try {
      await send('DELETE', `?setupId=${encodeURIComponent(setup.setupId)}`)
    } catch (error) {
      if (settle(error)) return
      toast.error('Could not discard Team Brain set-up', { description: error instanceof Error ? error.message : undefined })
      return
    }
    showSetup(null)
    tb.close()
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['agents'] }),
      queryClient.invalidateQueries({ queryKey: ['volume-definitions'] }),
    ])
  }

  // The built-in default's provider: a URL alone saves a GitHub skillset wherever git is installed.
  // A failed add reads both lists again too: another admin's add meanwhile fails this one but makes the skillset present.
  const addPublicSkillset = () =>
    addSkillset.mutateAsync({ url: DEFAULT_PUBLIC_SKILLSET.url, provider: DEFAULT_PUBLIC_SKILLSET.provider })
      .catch((error: unknown) => Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skillsets'] }),
        queryClient.invalidateQueries({ queryKey: ['discoverable-agents'] }),
      ]).then(() => { throw error }))

  const startChat = async () => {
    if (!setup || !(await saves.current)) return
    // The window gives way to the app's "Setting up your agent..." card, which the onboarding session closes.
    tb.setLaunching(true)
    setOnboarding(true)
    try {
      const result = await send<{ agentSlug: string; firstPrompt?: string; failedAgents: number }>('POST', '/finish', {
        setupId: setup.setupId, setUpBy: setUpByOf(user, platform), accounts: connected?.accounts,
      })
      showSetup(null)
      // The record now marks the agent; the list must carry the mark before the page shows Team Brain.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
        queryClient.invalidateQueries({ queryKey: ['x-agent-policies'] }),
        queryClient.invalidateQueries({ queryKey: ['volume-definitions'] }),
      ])
      await startOnboardingSession(result.agentSlug, result.firstPrompt)
      if (result.failedAgents > 0) {
        toast.error(`Team Brain could not be added to ${result.failedAgents} ${result.failedAgents === 1 ? 'agent' : 'agents'}`, {
          description: 'Add the Team Brain drive to them from each agent’s Drives. Their first message to Team Brain will ask for approval.',
        })
      }
      tb.close()
    } catch (error) {
      setOnboarding(false)
      tb.setLaunching(false)
      if (settle(error)) return
      toast.error('Could not start Team Brain', { description: error instanceof Error ? error.message : 'Please try again.' })
    }
  }

  return {
    setup,
    choices: setup ?? FIRST_CHOICES,
    isPending: canSetUp && query.isPending,
    start, resume, discard, prepare, choose, goForward, addPublicSkillset, startChat,
  }
}

/**
 * The set-up drive's health: 'preparing' while its first copy runs, undefined until known. A drive list that can't be
 * read gives 'unread': what it said before may be out of date. `recheck` reads it again.
 */
export function usePreparedDriveHealth(setup: Pick<TeamBrainSetup, 'agentSlug' | 'volumeId'> | null): { health: MountSummaryWithHealth['health'] | 'unread' | undefined; recheck: () => void } {
  const { data: mounts, isError, refetch } = useAgentMounts(setup?.agentSlug ?? '')
  return { health: isError ? 'unread' : mounts?.find((mount) => mount.volumeId === setup?.volumeId)?.health, recheck: () => void refetch() }
}
