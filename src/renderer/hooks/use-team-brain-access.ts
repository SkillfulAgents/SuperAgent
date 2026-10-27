import { useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiFetch } from '@renderer/lib/api'
import { useAddMount, useRemoveMount } from '@renderer/hooks/use-mounts'
import { useSaveVolumeDefinition, useVolumeAgents, useVolumeDefinitions } from '@renderer/hooks/use-volume-definitions'

/** Let `slug` message the Team Brain agent and Team Brain read `slug`'s sessions, or stop both. */
async function setLinked(queryClient: QueryClient, slug: string, brainSlug: string, linked: boolean) {
  const init = linked ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'allow' }) } : { method: 'DELETE' }
  const results = await Promise.allSettled([
    apiFetch(`/api/agents/${slug}/x-agent-policies/invoke/${brainSlug}`, init),
    apiFetch(`/api/agents/${brainSlug}/x-agent-policies/read/${slug}`, init),
  ])
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['x-agent-policies', slug] }),
    queryClient.invalidateQueries({ queryKey: ['x-agent-policies', brainSlug] }),
    queryClient.invalidateQueries({ queryKey: ['inbound-x-agent', brainSlug] }),
    queryClient.invalidateQueries({ queryKey: ['home-graph'] }),
  ])
  if (results.some((result) => result.status === 'rejected' || !result.value.ok)) {
    throw new Error(linked ? 'Could not connect it to Team Brain' : 'Could not disconnect it from Team Brain')
  }
}

/** Allow Team Brain to list every agent, or read every agent's sessions (agents made later too), or clear it. */
export async function setTeamBrainReach(queryClient: QueryClient, brainSlug: string, operation: 'list' | 'read', allowed: boolean) {
  const res = await apiFetch(`/api/agents/${brainSlug}/x-agent-policies`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, targetSlug: null, decision: allowed ? 'allow' : 'default' }),
  })
  if (!res.ok) throw new Error('Could not change what Team Brain can see')
  await queryClient.invalidateQueries({ queryKey: ['x-agent-policies', brainSlug] })
}

/**
 * What an agent gets when it uses Team Brain: the drive, read-only, leave to message the Team Brain agent, and Team Brain reading its sessions.
 * `mount: false` when the drive already reaches every agent.
 */
export function useGiveTeamBrain() {
  const addMount = useAddMount()
  const queryClient = useQueryClient()
  return async (slug: string, { volumeId, brainSlug, mount = true }: { volumeId: string; brainSlug: string; mount?: boolean }) => {
    if (mount) await addMount.mutateAsync({ agentSlug: slug, volumeId, readOnly: true })
    await setLinked(queryClient, slug, brainSlug, true)
  }
}

/** Which agents use Team Brain once it is set up, read from its drive, and the switches that change it. */
export function useTeamBrainAccess(brainSlug: string, volumeId: string | undefined) {
  const give = useGiveTeamBrain()
  const removeMount = useRemoveMount()
  const saveVolume = useSaveVolumeDefinition()
  const { data: attached } = useVolumeAgents(volumeId)
  const { data: definitions } = useVolumeDefinitions()
  const definition = definitions?.find((d) => d.id === volumeId)
  const mountOf = (slug: string) => attached?.attachments.find((a) => a.agentSlug === slug)?.mountId
  const failed = (error: unknown) => toast.error('Could not change who uses Team Brain', { description: error instanceof Error ? error.message : undefined })

  // A change takes seconds (the agent's container picks the drive up or drops it), so its switch shows where it is going
  // and stays put until the drive's list of agents says so.
  const queryClient = useQueryClient()
  const [changing, setChanging] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const toggle = (slug: string, on: boolean) => {
    if (!volumeId || changing.has(slug)) return
    const mountId = mountOf(slug)
    setChanging((prev) => new Map(prev).set(slug, on))
    const change = on
      ? give(slug, { volumeId, brainSlug })
      : Promise.all([mountId && removeMount.mutateAsync({ agentSlug: slug, mountId }), setLinked(queryClient, slug, brainSlug, false)])
    void change
      .catch(failed)
      .then(() => queryClient.invalidateQueries({ queryKey: ['volume-agents', volumeId] }))
      .finally(() => setChanging((prev) => {
        const next = new Map(prev)
        next.delete(slug)
        return next
      }))
  }
  const setEveryAgent = (on: boolean, slugs: readonly string[]) => {
    if (!volumeId) return
    // Agents with their own attachment keep it, and with it their link to Team Brain.
    const others = slugs.filter((slug) => !mountOf(slug))
    void saveVolume
      .mutateAsync({ id: volumeId, global: on ? 'read' : null })
      .then(() => Promise.all([setTeamBrainReach(queryClient, brainSlug, 'read', on), ...others.map((slug) => setLinked(queryClient, slug, brainSlug, on))]))
      .catch(failed)
  }
  return {
    everyAgent: definition?.globalAccess != null,
    // Going global is the drive's managers' to change, and only a drive everyone can add can go.
    canGoGlobal: definition?.userId === null && !!definition.canManage,
    isOn: (slug: string) => changing.get(slug) ?? mountOf(slug) !== undefined,
    isChanging: (slug: string) => changing.has(slug),
    toggle,
    setEveryAgent,
  }
}
