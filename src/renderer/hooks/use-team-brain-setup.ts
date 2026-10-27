import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useOnboarding } from '@renderer/context/onboarding-context'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { fillTeamBrainSetupBlock, TEAM_BRAIN_CRON } from '@renderer/lib/team-brain/team-brain-setup-block'
import type { TeamBrainPrepared } from '@renderer/lib/team-brain/team-brain-schema'
import { getTeamBrainState, usesTeamBrain, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import type { VolumeDetails } from '@renderer/components/volumes/volume-details-schema'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ApiAgent } from '@shared/lib/types/api'
import { mountPathOf } from '@shared/lib/volumes/base-mountable-volume'
import type { VolumeSource } from '@shared/lib/volumes/volume-config-schema'
import { useDiscoverableAgents, useInstallAgentFromSkillset } from './use-agent-templates'
import { useAgents, useDeleteAgent, useStartAgent, useUpdateAgent } from './use-agents'
import { useConnectedAccounts } from './use-connected-accounts'
import { useAddMount } from './use-mounts'
import { setTeamBrainReach, useGiveTeamBrain } from './use-team-brain-access'
import { useStartOnboardingSession } from './use-start-onboarding-session'
import { useSettings, useUpdateSettings } from './use-settings'
import { useDeleteVolumeDefinition, useSaveVolumeDefinition } from './use-volume-definitions'

const TEAM_BRAIN_TEMPLATE_PATH = 'agents/team-brain/'

/**
 * Team Brain set-up for the page that hosts the modal. Saving the drive
 * prepares the agent and its drive and warm-starts the agent, as the new-agent
 * form does; Start chat launches them. Leaving the page mid-set-up cancels it.
 */
export function useTeamBrainSetup() {
  const tb = useTeamBrain()
  const { setOnboarding } = useOnboarding()
  const { user } = useUser()
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
  const startOnboardingSession = useStartOnboardingSession()
  const template = templates?.find((t) => t.skillsetId === DEFAULT_PUBLIC_SKILLSET.id && t.path === TEAM_BRAIN_TEMPLATE_PATH)
  const setUpSlug = agents?.find((agent) => agent.teamBrain)?.slug
  const { isAuthMode, isAdmin } = useUser()
  const settings = useSettings({ enabled: !isAuthMode || isAdmin })
  const mounted = useRef(true)
  // Bumped by each prepare and each cancel: work that finds it moved on belongs to an attempt that ended.
  const attempt = useRef(0)

  const discard = async ({ agentSlug, volumeId }: TeamBrainPrepared) => {
    // The drive delete refuses while the agent still has it attached.
    await deleteAgent.mutateAsync(agentSlug)
    await deleteVolume.mutateAsync(volumeId)
  }

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
    if (run !== attempt.current) return false
    const agent = await install.mutateAsync({
      skillsetId: template.skillsetId, agentPath: template.path, agentName: template.name, agentVersion: template.version,
    })
    if (run !== attempt.current) {
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
    startAgent.mutate({ slug: agent.slug, source: 'warm-start' }, {
      onError: (error) => captureRendererException(error, { tags: { area: 'team-brain', op: 'warm-start' } }),
    })
    tb.setPrepared(prepared)
    return true
  }

  const cancel = () => {
    attempt.current++
    const { prepared } = getTeamBrainState()
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
      instructions: fillTeamBrainSetupBlock(instructions, { agentSlug: prepared.agentSlug, brainPath: prepared.brainPath, schedule, setUpBy: user, accounts: connected?.accounts }),
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
    const { status } = getTeamBrainState()
    if (status === 'onboarding') cancel()
    if (status === 'launching') tb.cancelSetup()
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      leave.current()
    }
  }, [])

  return { agentSlug: setUpSlug, prepare, cancel, startChat }
}
