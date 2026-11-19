import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useOnboarding } from '@renderer/context/onboarding-context'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { fillTeamBrainSetupBlock, setUpByOf, TEAM_BRAIN_CRON } from '@renderer/lib/team-brain/team-brain-setup-block'
import { usesTeamBrain, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import type { VolumeDetails } from '@renderer/components/volumes/volume-details-schema'
import { TEAM_BRAIN_STEPS, type TeamBrainChoices, type TeamBrainSetup, type TeamBrainSetupView, type TeamBrainStep } from '@shared/lib/config/team-brain-schema'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ApiAgent } from '@shared/lib/types/api'
import type { MountSummaryWithHealth } from '@shared/lib/types/mount'
import { mountPathOf } from '@shared/lib/volumes/base-mountable-volume'
import type { VolumeSource } from '@shared/lib/volumes/volume-config-schema'
import { useDiscoverableAgents, useInstallAgentFromSkillset } from './use-agent-templates'
import { useAgents, useStartAgent, useUpdateAgent } from './use-agents'
import { useConnectedAccounts } from './use-connected-accounts'
import { usePlatformAuthStatus } from './use-platform-auth'
import { useAddMount, useAgentMounts } from './use-mounts'
import { setTeamBrainReach, useGiveTeamBrain, useTakeTeamBrain } from './use-team-brain-access'
import { useStartOnboardingSession } from './use-start-onboarding-session'
import { useAddSkillset } from './use-skillsets'
import { useSaveVolumeDefinition } from './use-volume-definitions'

const TEAM_BRAIN_TEMPLATE_PATH = 'agents/team-brain/'
const SETUP_KEY = ['team-brain-setup']

/** Choices before the set-up is claimed, as the server claims it with. */
const FIRST_CHOICES: TeamBrainChoices = { step: 'location', schedule: 'daily', everyAgent: true, agents: {} }

/** Where Resume opens: the saved step once the set-up's agent holds its drive, else where it lives. */
export const resumeStep = (view: TeamBrainSetupView): TeamBrainStep => (view.agent && view.drive ? view.setup.step : 'location')

/** A refused set-up request, with the server's reason. */
class SetupRefusal extends Error {
  constructor(message: string, readonly reason: string | undefined) {
    super(message)
  }
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}))
  return typeof body.error === 'string' ? body.error : fallback
}

/** The set-up's claim (see `src/api/lib/team-brain-setup.ts`). */
async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`/api/team-brain/setup${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (res.ok) return res.json()
  const answer = await res.json().catch(() => ({}))
  throw new SetupRefusal(answer.error ?? 'Team Brain set-up failed', answer.reason)
}

/** Fetch through the app's own routes, where a 404 means already gone. */
async function call(path: string, init: RequestInit | undefined, fallback: string): Promise<Response | null> {
  const res = await apiFetch(path, init)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(await errorOf(res, fallback))
  return res
}

async function removeAgent(slug: string): Promise<void> {
  await call(`/api/agents/${encodeURIComponent(slug)}`, { method: 'DELETE' }, 'Could not remove the Team Brain agent')
}

/** A drive the set-up made: off every agent Start chat gave it to, then deleted. */
async function removeDrive(volumeId: string): Promise<void> {
  const id = encodeURIComponent(volumeId)
  const listed = await call(`/api/volume-definitions/${id}/agents`, undefined, 'Could not remove the Team Brain drive')
  if (!listed) return
  const { attachments }: { attachments: { agentSlug: string; mountId: string }[] } = await listed.json()
  for (const { agentSlug, mountId } of attachments) {
    await call(`/api/agents/${encodeURIComponent(agentSlug)}/mounts/${encodeURIComponent(mountId)}`, { method: 'DELETE' }, 'Could not remove the Team Brain drive')
  }
  await call(`/api/volume-definitions/${id}`, { method: 'DELETE' }, 'Could not remove the Team Brain drive')
}

/**
 * Team Brain set-up for the page that hosts the window. The page runs it
 * through the app's own routes, as any agent and drive are made; the server
 * holds only its claim. Step 1 claims before it makes anything, records the
 * agent and the drive the moment each is made, and choices save as they
 * change, so a reload, another computer or another admin resumes where it
 * stopped. Closing the window keeps the set-up; Discard removes it.
 */
export function useTeamBrainSetup() {
  const tb = useTeamBrain()
  const { setOnboarding } = useOnboarding()
  const { user, isAuthMode, isAdmin } = useUser()
  const canSetUp = !isAuthMode || isAdmin
  const { data: platform } = usePlatformAuthStatus()
  const { data: connected } = useConnectedAccounts()
  const queryClient = useQueryClient()
  // Also warms the skillset cache the install reads from.
  const { data: templates } = useDiscoverableAgents()
  const { data: agents } = useAgents()
  const install = useInstallAgentFromSkillset()
  const addMount = useAddMount()
  const giveTeamBrain = useGiveTeamBrain()
  const takeTeamBrain = useTakeTeamBrain()
  const saveVolume = useSaveVolumeDefinition()
  const updateAgent = useUpdateAgent()
  const startAgent = useStartAgent()
  const addSkillset = useAddSkillset()
  const startOnboardingSession = useStartOnboardingSession()
  const template = templates?.find((t) => t.skillsetId === DEFAULT_PUBLIC_SKILLSET.id && t.path === TEAM_BRAIN_TEMPLATE_PATH)

  // Focus reads it again for the page, not under an open window: a set-up changed meanwhile surfaces as the refusal of its next save.
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
  /** Step 1 is done: the set-up's agent holds its drive. Either can be gone (deleted by hand, a tab closed mid-way). */
  const prepared = view?.agent && view.drive ? setup : null
  const latestView = () => queryClient.getQueryData<TeamBrainSetupView | null>(SETUP_KEY) ?? null
  const showView = (next: TeamBrainSetupView | null) => {
    // A new drive keeps the agent: read its drives again, or the old drive's health stays on show.
    if (next?.setup.volumeId !== latestView()?.setup.volumeId) {
      void queryClient.invalidateQueries({ queryKey: ['mounts'] })
    }
    queryClient.setQueryData(SETUP_KEY, next)
  }

  // A window past step 1 whose agent or drive is gone goes back to it.
  const stepOneDone = !!prepared
  const goToStep = tb.goToStep
  useEffect(() => {
    if (tb.isOnboarding && view && !stepOneDone && tb.state.step !== 'location') goToStep('location')
  }, [tb.isOnboarding, view, stepOneDone, tb.state.step, goToStep])

  // A start mounts only drives that are ready, so a drive still making its first copy waits for the agent's start.
  const driveHealth = usePreparedDriveHealth(prepared).health
  const warmed = useRef<string | null>(null)
  const warm = startAgent.mutate
  const agentSlug = prepared?.agentSlug
  useEffect(() => {
    if (!tb.isOnboarding || !agentSlug || driveHealth !== 'ok' || warmed.current === agentSlug) return
    warmed.current = agentSlug
    warm({ slug: agentSlug, source: 'warm-start' }, {
      onError: (error) => captureRendererException(error, { tags: { area: 'team-brain', op: 'warm-start' } }),
    })
  }, [tb.isOnboarding, agentSlug, driveHealth, warm])

  /** A refusal that says what happened instead: the window follows the set-up there is, or closes. Others show as errors. */
  const settle = async (error: unknown): Promise<boolean> => {
    if (!(error instanceof SetupRefusal)) return false
    if (error.reason === 'ready') {
      showView(null)
      tb.close()
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      toast.info('Team Brain was set up from another window.')
      return true
    }
    if (error.reason === 'discarded') {
      showView(null)
      tb.close()
      toast.info('Team Brain set-up was discarded.')
      return true
    }
    if (error.reason === 'stale' || error.reason === 'changed' || error.reason === 'incomplete') {
      const next = (await query.refetch()).data ?? null
      if (!next) {
        tb.close()
        toast.info('Team Brain set-up was discarded.')
        return true
      }
      tb.open(resumeStep(next))
      toast.info(error.reason === 'stale'
        ? 'A Team Brain set-up was already started. You’re continuing it.'
        : error.reason === 'changed' ? 'Team Brain set-up changed in another window. This shows it as it is now.' : 'Team Brain’s agent or drive is gone. Set up where it lives again.')
      return true
    }
    return false
  }

  /**
   * Step 1: claim the set-up, then make its agent and drive through the app's routes, recording each the moment it is
   * made. A set-up that has them already keeps its agent, and a new drive replaces its drive. False when the window now
   * shows another set-up instead.
   */
  const prepare = async (source: VolumeSource, details: VolumeDetails): Promise<boolean> => {
    if (!template) throw new Error('The Team Brain template is not available yet. Try again in a moment.')
    try {
      // Claimed first: a tab closed from here on leaves a set-up to resume, not an agent and a drive no one knows of.
      let current = latestView() ?? await send<TeamBrainSetupView>('POST', '')
      showView(current)
      const { setupId } = current.setup
      let slug = current.agent ? current.setup.agentSlug : null
      if (!slug) {
        const agent = await install.mutateAsync({
          skillsetId: template.skillsetId, agentPath: template.path, agentName: template.name, agentVersion: template.version,
        })
        // Before the install's agent-list refresh lands, so the list never shows it.
        tb.setInstalling(agent.slug)
        try {
          current = await send<TeamBrainSetupView>('PATCH', '', { setupId, agent: { slug: agent.slug, replaces: current.setup.agentSlug } })
        } catch (error) {
          tb.setInstalling(null)
          void removeAgent(agent.slug).catch(() => {})
          throw error
        }
        showView(current)
        // The list carries the set-up's mark before it stops hiding the agent.
        await queryClient.invalidateQueries({ queryKey: ['agents'] })
        tb.setInstalling(null)
        slug = agent.slug
      }
      if (current.setup.volumeId) {
        // Released before it is removed, so the set-up never names a drive being deleted.
        const old = current.setup.volumeId
        current = await send<TeamBrainSetupView>('PATCH', '', { setupId, drive: { volumeId: null, location: null, replaces: old } })
        showView(current)
        await removeDrive(old)
      }
      const mount = await addMount.mutateAsync({ agentSlug: slug, ...source, name: details.name, visibility: details.visibility })
      try {
        // Saving the drive is step 1 done: Resume opens past it.
        current = await send<TeamBrainSetupView>('PATCH', '', { setupId, drive: { volumeId: mount.volumeId, location: source.type, replaces: null }, step: 'agents' })
      } catch (error) {
        void removeDrive(mount.volumeId).catch(() => {})
        throw error
      }
      showView(current)
      return true
    } catch (error) {
      if (await settle(error)) return false
      // What was made before the failure is recorded: read it, so a retry continues it.
      void query.refetch()
      throw error
    }
  }

  // Saves go one after another, and Start chat waits for the last: it applies what the server holds.
  const saves = useRef<Promise<boolean>>(Promise.resolve(true))
  const queued = useRef(0)
  /** Save a change of choices as it is made. The window shows it at once. */
  const choose = (changes: Partial<TeamBrainChoices>) => {
    // The cache, not this render's copy: a step 1 that just finished has updated it.
    const current = latestView()
    if (!current) return
    showView({ ...current, setup: { ...current.setup, ...changes, agents: { ...current.setup.agents, ...changes.agents } } })
    const { setupId } = current.setup
    queued.current++
    saves.current = saves.current.then(() => send<TeamBrainSetupView>('PATCH', '', { setupId, ...changes }))
      .then((next) => {
        // A later change waiting to save is already on show; its own answer shows it saved.
        if (queued.current === 1) showView(next)
        return true
      }, async (error: unknown) => {
        if (await settle(error)) return false
        toast.error('Could not save Team Brain set-up', { description: error instanceof Error ? error.message : undefined })
        // What the server holds is what Start chat applies: show it and let Start chat go on.
        await query.refetch()
        return true
      })
      .finally(() => { queued.current-- })
  }

  /** Next: show the step, and save it when it is further than any reached. Back only shows it. */
  const goForward = (step: TeamBrainStep) => {
    tb.goToStep(step)
    const saved = latestView()?.setup.step
    if (saved && TEAM_BRAIN_STEPS.indexOf(step) > TEAM_BRAIN_STEPS.indexOf(saved)) choose({ step })
  }

  const start = () => tb.open('location')

  /** Resume at the saved step with the saved choices, or at where it lives when its agent or drive is gone. */
  const resume = () => {
    if (view) tb.open(resumeStep(view))
  }

  /** Discard: the claim goes first and answers what it made, so a page behind another window never removes a finished Team Brain. */
  const discard = async () => {
    if (!setup) return
    let made: Pick<TeamBrainSetup, 'agentSlug' | 'volumeId'>
    try {
      made = await send('DELETE', `?setupId=${encodeURIComponent(setup.setupId)}`)
    } catch (error) {
      if (await settle(error)) return
      toast.error('Could not discard Team Brain set-up', { description: error instanceof Error ? error.message : undefined })
      return
    }
    showView(null)
    tb.close()
    try {
      // The agent first: its drive is then off it, and removing the drive takes it off any agent Start chat gave it to.
      if (made.agentSlug) await removeAgent(made.agentSlug)
      if (made.volumeId) await removeDrive(made.volumeId)
    } catch (error) {
      toast.error('Team Brain set-up was discarded, but its agent or drive is still there', {
        description: `${error instanceof Error ? error.message : 'Please try again.'} Remove it from the sidebar or Settings → Drives.`,
      })
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
        queryClient.invalidateQueries({ queryKey: ['volume-definitions'] }),
      ])
    }
  }

  // The built-in default's provider: a URL alone saves a GitHub skillset wherever git is installed.
  // A failed add re-reads both lists: another admin may have added it meanwhile.
  const addPublicSkillset = () =>
    addSkillset.mutateAsync({ url: DEFAULT_PUBLIC_SKILLSET.url, provider: DEFAULT_PUBLIC_SKILLSET.provider }).catch((error: unknown) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skillsets'] }),
        queryClient.invalidateQueries({ queryKey: ['discoverable-agents'] }),
      ]).then(() => { throw error }))

  /**
   * Each agent the admin's lists show, set to what the choices say: given Team Brain, or what an earlier Start chat
   * gave it taken back. Failures are counted for a warning; the admin changes those from Team Brain's page.
   */
  const applyAgentChoices = async ({ agentSlug: brainSlug, volumeId, everyAgent, agents: chosen }: TeamBrainSetup & { agentSlug: string; volumeId: string }) => {
    const others = (agents ?? []).map((agent) => agent.slug).filter((slug) => slug !== brainSlug)
    const on = others.filter((slug) => usesTeamBrain({ everyAgent, agents: chosen }, slug))
    const off = others.filter((slug) => !on.includes(slug))
    let mounted = new Map<string, string>()
    let read = new Set<string>()
    if (off.length > 0) {
      const [attachments, policies] = await Promise.all([
        call(`/api/volume-definitions/${encodeURIComponent(volumeId)}/agents`, undefined, 'Could not read the Team Brain drive'),
        call(`/api/agents/${encodeURIComponent(brainSlug)}/x-agent-policies`, undefined, 'Could not read what Team Brain can see'),
      ])
      mounted = new Map((((await attachments?.json()) as { attachments?: { agentSlug: string; mountId: string }[] } | undefined)?.attachments ?? []).map((a) => [a.agentSlug, a.mountId]))
      read = new Set((((await policies?.json()) as { policies?: { operation: string; targetAgentSlug: string | null }[] } | undefined)?.policies ?? [])
        .filter((p) => p.operation === 'read' && p.targetAgentSlug).map((p) => p.targetAgentSlug!))
    }
    const results = await Promise.allSettled([
      ...on.map((slug) => giveTeamBrain(slug, { volumeId, brainSlug, mount: !everyAgent })),
      ...off.filter((slug) => mounted.has(slug) || read.has(slug)).map((slug) => takeTeamBrain(slug, { brainSlug, mountId: mounted.get(slug) })),
    ])
    return results.filter((result) => result.status === 'rejected').length
  }

  /** Fill the agent's setup block: who set it up, where the drive is mounted, and how often it syncs. */
  const fillInstructions = async ({ agentSlug: slug, volumeId, schedule }: TeamBrainSetup & { agentSlug: string; volumeId: string }) => {
    const [agentRes, mountsRes] = await Promise.all([
      apiFetch(`/api/agents/${encodeURIComponent(slug)}`),
      apiFetch(`/api/agents/${encodeURIComponent(slug)}/mounts`),
    ])
    if (!agentRes.ok || !mountsRes.ok) throw new Error('Could not read the Team Brain agent')
    const { instructions = '' }: ApiAgent = await agentRes.json()
    const mount = ((await mountsRes.json()) as MountSummaryWithHealth[]).find((m) => m.volumeId === volumeId)
    if (!mount) throw new Error('Could not read the Team Brain drive')
    await updateAgent.mutateAsync({
      slug,
      instructions: fillTeamBrainSetupBlock(instructions, {
        agentSlug: slug, brainPath: mountPathOf(mount.name), schedule, setUpBy: setUpByOf(user, platform), accounts: connected?.accounts,
      }),
    })
  }

  /**
   * Start chat: set up the drive, upkeep, what Team Brain sees and each agent through the app's routes, then mark it
   * ready, which gives members access, and open its first chat. Each call sets what the choices say, so a Start chat
   * run again after a failure or a changed choice ends where the choices are.
   */
  const startChat = async () => {
    if (!prepared || !(await saves.current)) return
    const latest = latestView()
    if (!latest?.agent || !latest.drive) return
    const current = latest.setup as TeamBrainSetup & { agentSlug: string; volumeId: string }
    const { setupId, agentSlug: brainSlug, volumeId, everyAgent, schedule } = current
    // The window gives way to the app's "Setting up your agent..." card, which the onboarding session closes.
    tb.setLaunching(true)
    setOnboarding(true)
    try {
      // Team Brain's own read-write attachment wins over the global read-only one.
      await saveVolume.mutateAsync({ id: volumeId, global: everyAgent ? 'read' : null })
      const upkeep = await apiFetch(`/api/agents/${encodeURIComponent(brainSlug)}/team-brain/upkeep`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduleExpression: TEAM_BRAIN_CRON[schedule] }),
      })
      if (!upkeep.ok) throw new Error(await errorOf(upkeep, 'Could not schedule Brain upkeep'))
      // Team Brain can list every agent, and read every agent's sessions with Every agent.
      await Promise.all([
        setTeamBrainReach(queryClient, brainSlug, 'list', true),
        setTeamBrainReach(queryClient, brainSlug, 'read', everyAgent),
      ])
      const failed = await applyAgentChoices(current)
      await fillInstructions(current)
      const ready = await send<{ agentSlug: string; firstPrompt?: string }>('POST', '/ready', { setupId })
      showView(null)
      // The record now marks the agent; the list must carry the mark before the page shows Team Brain.
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      await startOnboardingSession(ready.agentSlug, ready.firstPrompt)
      if (failed > 0) {
        toast.error(`Team Brain could not be added to ${failed} ${failed === 1 ? 'agent' : 'agents'}`, {
          description: 'Change who uses it from Team Brain’s page. Their first message to Team Brain will ask for approval.',
        })
      }
      tb.close()
    } catch (error) {
      setOnboarding(false)
      tb.setLaunching(false)
      if (await settle(error)) return
      void query.refetch()
      toast.error('Could not start Team Brain', { description: error instanceof Error ? error.message : 'Please try again.' })
    }
  }

  return {
    view,
    setup,
    prepared,
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
