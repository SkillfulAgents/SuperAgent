import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useOnboarding } from '@renderer/context/onboarding-context'
import { useUser } from '@renderer/context/user-context'
import { removeAgentFromCache } from '@renderer/lib/agent-cache'
import { apiFetch } from '@renderer/lib/api'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { fillTeamBrainSetupBlock, setUpByOf, TEAM_BRAIN_CRON } from '@renderer/lib/team-brain/team-brain-setup-block'
import type { TeamBrainPrepared } from '@renderer/lib/team-brain/team-brain-schema'
import { getTeamBrainState, restoredSetupOutcome, usesTeamBrain, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import type { VolumeDetails } from '@renderer/components/volumes/volume-details-schema'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ApiAgent } from '@shared/lib/types/api'
import type { MountSummaryWithHealth } from '@shared/lib/types/mount'
import { mountPathOf } from '@shared/lib/volumes/base-mountable-volume'
import type { VolumeSource } from '@shared/lib/volumes/volume-config-schema'
import { useDiscoverableAgents, useInstallAgentFromSkillset } from './use-agent-templates'
import { useAgents, useDeleteAgent, useStartAgent, useUpdateAgent } from './use-agents'
import { useConnectedAccounts } from './use-connected-accounts'
import { usePlatformAuthStatus } from './use-platform-auth'
import { useAddMount, useAgentMounts } from './use-mounts'
import { setTeamBrainReach, useGiveTeamBrain } from './use-team-brain-access'
import { useStartOnboardingSession } from './use-start-onboarding-session'
import { useSettings, useUpdateSettings } from './use-settings'
import { useAddSkillset } from './use-skillsets'
import { useDeleteVolumeDefinition, useSaveVolumeDefinition } from './use-volume-definitions'

const TEAM_BRAIN_TEMPLATE_PATH = 'agents/team-brain/'

/**
 * Team Brain set-up for the page that hosts the modal. Saving the drive
 * prepares the agent and its drive, and the agent warm-starts once the drive can
 * mount, as the new-agent form does; Start chat launches them. Leaving the page
 * mid-set-up cancels it.
 */
export function useTeamBrainSetup() {
  const tb = useTeamBrain()
  const { setOnboarding } = useOnboarding()
  const { user } = useUser()
  const { data: platform } = usePlatformAuthStatus()
  const { data: connected } = useConnectedAccounts()
  const queryClient = useQueryClient()
  // Also warms the skillset cache the install reads from.
  const { data: templates } = useDiscoverableAgents()
  const { data: agents } = useAgents()
  const install = useInstallAgentFromSkillset()
  const addMount = useAddMount()
  const giveTeamBrain = useGiveTeamBrain()
  const startAgent = useStartAgent()
  const deleteAgent = useDeleteAgent()
  const deleteVolume = useDeleteVolumeDefinition()
  const saveVolume = useSaveVolumeDefinition()
  const updateAgent = useUpdateAgent()
  const updateSettings = useUpdateSettings()
  const addSkillset = useAddSkillset()
  const startOnboardingSession = useStartOnboardingSession()
  const template = templates?.find((t) => t.skillsetId === DEFAULT_PUBLIC_SKILLSET.id && t.path === TEAM_BRAIN_TEMPLATE_PATH)
  const setUpSlug = agents?.find((agent) => agent.teamBrain)?.slug
  const { isAuthMode, isAdmin } = useUser()
  const canSetUp = !isAuthMode || isAdmin
  const settings = useSettings({ enabled: canSetUp })
  const mounted = useRef(true)
  // Bumped by each prepare and each cancel: work that finds it moved on belongs to an attempt that ended.
  const attempt = useRef(0)
  // A start mounts only drives that are ready, so a drive still making its first copy waits for the agent's start.
  const draft = tb.state.prepared
  const driveHealth = usePreparedDriveHealth(draft).health
  const warmed = useRef<TeamBrainPrepared | null>(null)
  const warm = startAgent.mutate
  useEffect(() => {
    if (!draft || driveHealth !== 'ok' || warmed.current === draft || !canSetUp) return
    warmed.current = draft
    warm({ slug: draft.agentSlug, source: 'warm-start' }, {
      onError: (error) => captureRendererException(error, { tags: { area: 'team-brain', op: 'warm-start' } }),
    })
  }, [draft, driveHealth, warm, canSetUp])

  const discard = async ({ agentSlug, volumeId }: TeamBrainPrepared) => {
    // The drive delete refuses while the agent still has it attached.
    await deleteAgent.mutateAsync(agentSlug)
    await deleteVolume.mutateAsync(volumeId)
  }

  // At mount a set-up in progress is one restored from storage, since leaving the page ends any other.
  // The server says whether it launched, lost its agent, or lost the record to another set-up.
  const restored = useRef(tb.state.status === 'off' ? null : tb.state)
  useEffect(() => {
    const saved = restored.current
    if (!saved || !settings.data || !agents) return
    restored.current = null
    const report = (error: unknown) => captureRendererException(error, { tags: { area: 'team-brain', op: 'discard-restored-setup' } })
    const current = getTeamBrainState()
    // Left while its drive was being made: nothing can resume it.
    if (saved.installing) {
      void deleteAgent.mutateAsync(saved.installing).catch(report)
      if (current.installing === saved.installing) tb.setInstalling(null)
    }
    const { prepared } = saved
    // A launch started since the page loaded decides for itself.
    if (!prepared || current.prepared?.agentSlug !== prepared.agentSlug || current.status !== saved.status) return
    const agentFound = agents.some((agent) => agent.slug === prepared.agentSlug)
    const outcome = restoredSetupOutcome(prepared.agentSlug, settings.data.teamBrain?.agentSlug, agentFound)
    if (outcome === 'resume') {
      tb.setLaunching(false)
      return
    }
    if (outcome === 'gone') void (agentFound ? discard(prepared) : deleteVolume.mutateAsync(prepared.volumeId)).catch(report)
    tb.cancelSetup()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the record and agents are first known
  }, [settings.data, agents])

  const prepare = async (source: VolumeSource, details: VolumeDetails) => {
    // The agent list holds only the agents shared with this admin; the workspace record says whether one exists.
    const run = ++attempt.current
    if (setUpSlug || (await settings.refetch({ throwOnError: true })).data?.teamBrain) throw new Error('Team Brain is already set up.')
    if (!template) throw new Error('The Team Brain template is not available yet. Try again in a moment.')
    const previous = getTeamBrainState().prepared
    if (previous) {
      await discard(previous)
      if (run === attempt.current) tb.setPrepared(null)
    }
    if (run !== attempt.current || !mounted.current) return false
    const agent = await install.mutateAsync({
      skillsetId: template.skillsetId, agentPath: template.path, agentName: template.name, agentVersion: template.version,
    })
    if (run !== attempt.current || !mounted.current) {
      void deleteAgent.mutateAsync(agent.slug).catch(() => {})
      return false
    }
    // Before the install's agent-list refresh lands, so the list never shows it.
    tb.setInstalling(agent.slug)
    let prepared: TeamBrainPrepared
    try {
      const mount = await addMount.mutateAsync({ agentSlug: agent.slug, ...source, name: details.name, visibility: details.visibility })
      prepared = { agentSlug: agent.slug, volumeId: mount.volumeId, brainPath: mountPathOf(mount.name), firstPrompt: agent.onboardingFirstPrompt }
    } catch (error) {
      void deleteAgent.mutateAsync(agent.slug).catch(() => {})
      if (run !== attempt.current) return false
      tb.setInstalling(null)
      throw error
    }
    // Left or cancelled while the drive was made: nothing should keep it.
    if (!mounted.current || run !== attempt.current) {
      void discard(prepared).catch(() => {})
      return false
    }
    tb.setPrepared(prepared)
    return true
  }

  // The built-in default's provider: a URL alone saves a GitHub skillset wherever git is installed.
  // A failed add reads both lists again too: another admin's add meanwhile fails this one but makes the skillset present.
  const addPublicSkillset = () =>
    addSkillset.mutateAsync({ url: DEFAULT_PUBLIC_SKILLSET.url, provider: DEFAULT_PUBLIC_SKILLSET.provider })
      .catch((error: unknown) => Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skillsets'] }),
        queryClient.invalidateQueries({ queryKey: ['discoverable-agents'] }),
      ]).then(() => { throw error }))

  const cancel = () => {
    attempt.current++
    const { prepared } = getTeamBrainState()
    // Set-up hides the agent from the lists; once it ends nothing would until the delete lands.
    if (prepared) removeAgentFromCache(queryClient, prepared.agentSlug)
    tb.cancelSetup()
    if (prepared) {
      discard(prepared).catch((error: unknown) => {
        toast.error('Could not remove the Team Brain agent', { description: error instanceof Error ? error.message : undefined })
      })
    }
  }

  /** Launches the prepared Team Brain; false when another admin's set-up took the record first. */
  const launch = async (prepared: TeamBrainPrepared, onRecordWrite: () => void) => {
    const state = getTeamBrainState()
    const { schedule, everyAgent } = state
    const chosen = (agents ?? [])
      .filter((agent) => agent.slug !== prepared.agentSlug && (everyAgent || usesTeamBrain(state, agent.slug)))
      .map((agent) => agent.slug)
    const res = await apiFetch(`/api/agents/${prepared.agentSlug}`)
    if (!res.ok) throw new Error('Could not read the Team Brain agent')
    const { instructions = '' }: ApiAgent = await res.json()
    await updateAgent.mutateAsync({
      slug: prepared.agentSlug,
      instructions: fillTeamBrainSetupBlock(instructions, { agentSlug: prepared.agentSlug, brainPath: prepared.brainPath, schedule, setUpBy: setUpByOf(user, platform), accounts: connected?.accounts }),
    })
    // Only a refusal says the record is not this set-up's: after any other failure it may have been saved.
    onRecordWrite()
    const taken = await updateSettings.mutateAsync({ teamBrain: { agentSlug: prepared.agentSlug, volumeId: prepared.volumeId } })
      .then(() => false, (error: unknown) => {
        if (typeof error === 'object' && error !== null && 'status' in error && error.status === 409) return true
        throw error
      })
    if (taken) {
      await discard(prepared).catch((error: unknown) => captureRendererException(error, { tags: { area: 'team-brain', op: 'discard-losing-setup' } }))
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      return false
    }
    // Published once the record is this set-up's. Team Brain's own read-write attachment wins over the global read-only one.
    if (everyAgent) await saveVolume.mutateAsync({ id: prepared.volumeId, global: 'read' })
    const upkeep = await apiFetch(`/api/agents/${prepared.agentSlug}/team-brain/upkeep`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduleExpression: TEAM_BRAIN_CRON[schedule] }),
    }).catch(() => null)
    // Past the record Team Brain exists, so a failure here is reported, never thrown back into a set-up that would delete it.
    if (!upkeep?.ok) toast.error('Could not schedule Brain upkeep', { description: 'Team Brain is set up but will not sync on its own yet.' })
    // The record marks the agent; the list must carry the mark before set-up stops hiding it.
    await queryClient.invalidateQueries({ queryKey: ['agents'] })

    // Running agents pick the drive up on their next start. Team Brain can list and read them before its first chat.
    const [attached, reached] = await Promise.all([
      Promise.allSettled(chosen.map((slug) => giveTeamBrain(slug, { volumeId: prepared.volumeId, brainSlug: prepared.agentSlug, mount: !everyAgent }))),
      Promise.allSettled([
        setTeamBrainReach(queryClient, prepared.agentSlug, 'list', true),
        everyAgent && setTeamBrainReach(queryClient, prepared.agentSlug, 'read', true),
      ]).then((results) => results.every((result) => result.status === 'fulfilled')),
    ])
    await startOnboardingSession(prepared.agentSlug, prepared.firstPrompt)
    const failed = attached.filter((result) => result.status === 'rejected').length
    if (failed > 0) {
      toast.error(`Team Brain could not be added to ${failed} ${failed === 1 ? 'agent' : 'agents'}`, {
        description: 'Add the Team Brain drive to them from each agent’s Drives. Their first message to Team Brain will ask for approval.',
      })
    }
    if (!reached) {
      toast.error('Team Brain cannot see your other agents yet', { description: 'Allow it from Team Brain’s “Connect this agent to others” settings.' })
    }
    return true
  }

  const startChat = async () => {
    const { prepared } = getTeamBrainState()
    if (!prepared) return
    // The modal gives way to the app's "Setting up your agent..." card, which the onboarding session closes.
    tb.setLaunching(true)
    setOnboarding(true)
    let recordWritten = false
    try {
      // Stays `launching`, the page blank, until the session replaces the page.
      if (!(await launch(prepared, () => { recordWritten = true }))) {
        setOnboarding(false)
        toast.info('Another admin already set up Team Brain', { description: 'This set-up was removed. The page shows theirs.' })
      }
      // Set-up is over whether or not the session opened; without it the page shows Team Brain.
      tb.cancelSetup()
    } catch (error) {
      setOnboarding(false)
      // Once the record was written the draft may be the Team Brain: forget it, so leaving cannot delete it.
      if (recordWritten) tb.cancelSetup()
      else tb.setLaunching(false)
      toast.error('Could not start Team Brain', { description: error instanceof Error ? error.message : 'Please try again.' })
    }
  }

  // Leaving mid-set-up cancels it; leaving for the launched session just resets the modal.
  const leave = useRef(() => {})
  leave.current = () => {
    // A member's visit never ends an admin's set-up kept in this browser.
    if (!canSetUp) return
    const { status } = getTeamBrainState()
    if (status === 'onboarding') cancel()
    if (status === 'launching') tb.cancelSetup()
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // StrictMode replays effects without a real leave: wait for its setup to restore the mounted flag.
      queueMicrotask(() => {
        if (!mounted.current) leave.current()
      })
    }
  }, [])

  return { agentSlug: setUpSlug, prepare, addPublicSkillset, cancel, startChat }
}

/**
 * The prepared drive's health: 'preparing' while its first copy runs, undefined until known. A drive list that can't be
 * read gives 'unread': what it said before may be out of date. `recheck` reads it again.
 */
export function usePreparedDriveHealth(prepared: TeamBrainPrepared | null): { health: MountSummaryWithHealth['health'] | 'unread' | undefined; recheck: () => void } {
  const { data: mounts, isError, refetch } = useAgentMounts(prepared?.agentSlug ?? '')
  return { health: isError ? 'unread' : mounts?.find((mount) => mount.volumeId === prepared?.volumeId)?.health, recheck: () => void refetch() }
}
