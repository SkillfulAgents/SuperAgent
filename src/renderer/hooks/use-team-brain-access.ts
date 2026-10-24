import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiFetch } from '@renderer/lib/api'
import { useAddMount, useRemoveMount } from '@renderer/hooks/use-mounts'
import { useSaveVolumeDefinition, useVolumeAgents, useVolumeDefinitions } from '@renderer/hooks/use-volume-definitions'

/** Let `slug` message the Team Brain agent, or stop it. */
async function setMessaging(slug: string, brainSlug: string, allowed: boolean) {
  const res = await apiFetch(
    `/api/agents/${slug}/x-agent-policies/invoke/${brainSlug}`,
    allowed ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'allow' }) } : { method: 'DELETE' },
  )
  if (!res.ok) throw new Error(allowed ? 'Could not let it message Team Brain' : 'Could not stop it messaging Team Brain')
}

/**
 * What an agent gets when it uses Team Brain: the drive, read-only, and leave to message the Team Brain agent.
 * `mount: false` when the drive already reaches every agent.
 */
export function useGiveTeamBrain() {
  const addMount = useAddMount()
  return async (slug: string, { volumeId, brainSlug, mount = true }: { volumeId: string; brainSlug: string; mount?: boolean }) => {
    if (mount) await addMount.mutateAsync({ agentSlug: slug, volumeId, readOnly: true })
    await setMessaging(slug, brainSlug, true)
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
      : Promise.all([mountId && removeMount.mutateAsync({ agentSlug: slug, mountId }), setMessaging(slug, brainSlug, false)])
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
    // Agents with their own attachment keep it, and with it their leave to message Team Brain.
    const others = slugs.filter((slug) => !mountOf(slug))
    void saveVolume
      .mutateAsync({ id: volumeId, global: on ? 'read' : null })
      .then(() => Promise.all(others.map((slug) => setMessaging(slug, brainSlug, on))))
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
