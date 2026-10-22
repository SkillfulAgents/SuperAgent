import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useOnboarding } from '@renderer/context/onboarding-context'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { fillTeamBrainSetupBlock } from '@renderer/lib/team-brain/team-brain-setup-block'
import type { TeamBrainPrepared } from '@renderer/lib/team-brain/team-brain-schema'
import { getTeamBrainState, usesTeamBrain, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import type { VolumeDetails } from '@renderer/components/volumes/volume-details-schema'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ApiAgent } from '@shared/lib/types/api'
import { mountPathOf } from '@shared/lib/volumes/base-mountable-volume'
import type { VolumeSource } from '@shared/lib/volumes/volume-config-schema'
import { useDiscoverableAgents, useInstallAgentFromSkillset } from './use-agent-templates'
import { useAgents, useDeleteAgent, useStartAgent, useUpdateAgent } from './use-agents'
import { useAddMount, useSetMountReadOnly } from './use-mounts'
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
  const queryClient = useQueryClient()
  // Also warms the skillset cache the install reads from.
  const { data: templates } = useDiscoverableAgents()
  const { data: agents } = useAgents()
  const install = useInstallAgentFromSkillset()
  const addMount = useAddMount()
  const setMountReadOnly = useSetMountReadOnly()
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
      prepared = {
        agentSlug: agent.slug, volumeId: mount.volumeId, brainPath: mountPathOf(mount.name), firstPrompt: agent.onboardingFirstPrompt,
        isPublic: details.visibility === 'public',
      }
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

  const launch = async (prepared: TeamBrainPrepared) => {
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
      instructions: fillTeamBrainSetupBlock(instructions, { agentSlug: prepared.agentSlug, brainPath: prepared.brainPath, schedule }),
    })
    // Team Brain's own read-write attachment wins over the global read-only one.
    if (everyAgent) await saveVolume.mutateAsync({ id: prepared.volumeId, global: 'read' })
    await updateSettings.mutateAsync({ teamBrain: { agentSlug: prepared.agentSlug, volumeId: prepared.volumeId } })
    // The record marks the agent; the list must carry the mark before set-up stops hiding it.
    await queryClient.invalidateQueries({ queryKey: ['agents'] })

    // Running agents pick the drive up on their next start.
    const attached = Promise.allSettled(chosen.map(async (slug) => {
      if (!everyAgent) {
        const mount = await addMount.mutateAsync({ agentSlug: slug, volumeId: prepared.volumeId })
        await setMountReadOnly.mutateAsync({ agentSlug: slug, mountId: mount.id, readOnly: true })
      }
      const grant = await apiFetch(`/api/agents/${slug}/x-agent-policies/invoke/${prepared.agentSlug}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'allow' }),
      })
      if (!grant.ok) throw new Error('Could not let it message Team Brain')
    }))
    await startOnboardingSession(prepared.agentSlug, prepared.firstPrompt)
    const failed = (await attached).filter((result) => result.status === 'rejected').length
    if (failed > 0) {
      toast.error(`Team Brain could not be added to ${failed} ${failed === 1 ? 'agent' : 'agents'}`, {
        description: 'Add the Team Brain drive to them from each agent’s Drives. Their first message to Team Brain will ask for approval.',
      })
    }
  }

  const startChat = async () => {
    const { prepared } = getTeamBrainState()
    if (!prepared) return
    // The modal gives way to the app's "Setting up your agent..." card, which the onboarding session closes.
    tb.setLaunching(true)
    setOnboarding(true)
    try {
      // Stays `launching`, the page blank, until the session replaces the page.
      await launch(prepared)
      // Set-up is over whether or not the session opened; without it the page shows Team Brain.
      tb.cancelSetup()
    } catch (error) {
      setOnboarding(false)
      tb.setLaunching(false)
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
