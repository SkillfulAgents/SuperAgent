import { ClipboardCopy, FolderSearch } from 'lucide-react'
import { toast } from 'sonner'
import type { FolderTab } from '@renderer/context/file-preview-context'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { copyLazyTextToClipboard } from '@renderer/lib/clipboard'
import { canUseHostFeatures } from '@renderer/lib/host-features'

interface FolderHostActionsProps {
  folder: FolderTab
}

export function revealFolderLabel(): string {
  if (window.electronAPI?.platform === 'darwin') return 'Reveal in Finder'
  if (window.electronAPI?.platform === 'win32') return 'Reveal in File Explorer'
  return 'Reveal in Files'
}

async function getResponseError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null
  return payload?.error ?? fallback
}

/**
 * Header actions for a folder tab that deal in the folder's HOST path: copy
 * it, or reveal it in this computer's file manager. Both resolve the path
 * through the same endpoint the entry context menu's Reveal uses, so the
 * workspace root-containment rules apply. Owner-only, like that endpoint.
 *
 * Copy is offered everywhere (a path is just text — against a remote
 * deployment it is the deployment's path, which is what you'd want to paste
 * into an ssh session). Reveal is host-gated: opening a remote host's path
 * here lands nowhere, or on a same-named folder of yours.
 */
export function FolderHostActions({ folder }: FolderHostActionsProps) {
  const { canAdminAgent } = useUser()
  if (!canAdminAgent(folder.agentSlug)) return null

  const electronRevealAvailable = canUseHostFeatures() && !!window.electronAPI?.revealInFolder

  const resolveHostPath = async (): Promise<string> => {
    const response = await apiFetch(
      `/api/agents/${encodeURIComponent(folder.agentSlug)}/folders/reveal-path`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: folder.rootPath, path: folder.rootPath }),
      },
    )
    if (!response.ok) throw new Error(await getResponseError(response, 'Failed to resolve folder path'))
    const { hostPath } = await response.json() as { hostPath: string }
    return hostPath
  }

  const handleCopyPath = async () => {
    try {
      await copyLazyTextToClipboard(resolveHostPath)
      toast.success('Folder path copied')
    } catch (error) {
      toast.error('Could not copy folder path', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const handleReveal = async () => {
    const electronApi = window.electronAPI
    if (!electronApi?.revealInFolder) return
    try {
      const revealError = await electronApi.revealInFolder(await resolveHostPath())
      if (revealError) throw new Error(revealError)
    } catch (error) {
      toast.error('Could not reveal folder', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleCopyPath}
        className="p-0.5 rounded hover:bg-muted transition-colors"
        title="Copy folder path"
        aria-label="Copy folder path"
        data-testid="folder-copy-path"
      >
        <ClipboardCopy className="h-4 w-4" />
      </button>
      {electronRevealAvailable && (
        <button
          type="button"
          onClick={handleReveal}
          className="p-0.5 rounded hover:bg-muted transition-colors"
          title={revealFolderLabel()}
          aria-label={revealFolderLabel()}
          data-testid="folder-reveal"
        >
          <FolderSearch className="h-4 w-4" />
        </button>
      )}
    </>
  )
}
