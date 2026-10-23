import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useOnboarding } from '@renderer/context/onboarding-context'
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
import { useAddMount } from './use-mounts'
import { useGiveTeamBrain } from './use-team-brain-access'
import { useStartOnboardingSession } from './use-start-onboarding-session'
import { useUpdateSettings } from './use-settings'
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
  const mounted = useRef(true)

  const discard = async ({ agentSlug, volumeId }: TeamBrainPrepared) => {
    // The drive delete refuses while the agent still has it attached.
    await deleteAgent.mutateAsync(agentSlug)
    await deleteVolume.mutateAsync(volumeId)
  }

  const prepare = async (source: VolumeSource, details: VolumeDetails) => {
    if (setUpSlug) throw new Error('Team Brain is already set up.')
    if (!template) throw new Error('The Team Brain template is not available yet. Try again in a moment.')
    const previous = getTeamBrainState().prepared
    if (previous) {
      await discard(previous)
      tb.setPrepared(null)
    }
    const agent = await install.mutateAsync({
      skillsetId: template.skillsetId, agentPath: template.path, agentName: template.name, agentVersion: template.version,
    })
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
      tb.setInstalling(null)
      await deleteAgent.mutateAsync(agent.slug).catch(() => {})
      throw error
    }
    if (!mounted.current) return void discard(prepared).catch(() => {})
    startAgent.mutate({ slug: agent.slug, source: 'warm-start' }, {
      onError: (error) => captureRendererException(error, { tags: { area: 'team-brain', op: 'warm-start' } }),
    })
    tb.setPrepared(prepared)
  }

  const cancel = () => {
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
    const attached = Promise.allSettled(chosen.map((slug) => giveTeamBrain(slug, { volumeId: prepared.volumeId, brainSlug: prepared.agentSlug, mount: !everyAgent })))
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
