import { useCallback } from 'react'
import { toast } from 'sonner'
import { useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { assignAgentToFolder } from '@renderer/lib/agent-folders'

/**
 * Files a just-created agent into the left-nav section whose + started it.
 * Resolved against the latest settings when the serialized write runs, like
 * every other filing. A failure is reported, never thrown: the agent exists,
 * and a retry would create a duplicate.
 */
export function useFileAgentIntoSection(): (slug: string, section: string | undefined) => Promise<void> {
  const { mutateAsync: updateSettings } = useUpdateUserSettings()
  return useCallback(async (slug, section) => {
    if (!section) return
    try {
      await updateSettings((current) => ({
        agentFolderAssignments: assignAgentToFolder(current.agentFolderAssignments, slug, section),
      }))
    } catch {
      toast.error('Agent created, but could not add it to the section', {
        description: 'You can find it in Your Agents and move it from there.',
      })
    }
  }, [updateSettings])
}
