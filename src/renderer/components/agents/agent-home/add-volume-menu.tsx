import { useState } from 'react'
import { z } from 'zod'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Plus, Trash2 } from 'lucide-react'
import type { SharedVolumeListItem } from '@renderer/hooks/use-shared-volumes'

const MOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function previewMountName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50)
}

const nameSchema = z.string().trim().min(1, 'Name is required').refine(
  (name) => MOUNT_NAME_RE.test(previewMountName(name)),
  'Name must produce a path like /volumes/team-brain',
)

interface AddVolumeMenuProps {
  agentSlug: string
  volumes: SharedVolumeListItem[]
  onCreate: (name: string) => Promise<void>
  onAttach: (volumeId: string) => Promise<void>
  onDelete: (volumeId: string) => Promise<void>
}

export function AddVolumeMenu({ agentSlug, volumes, onCreate, onAttach, onDelete }: AddVolumeMenuProps) {
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<SharedVolumeListItem | null>(null)

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Add shared volume">
            <Plus />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-1">
          <button
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
            onClick={() => {
              setOpen(false)
              setCreateOpen(true)
            }}
          >
            New shared volume…
          </button>
          {volumes.length > 0 && (
            <div className="mt-1 border-t border-border/50 pt-1">
              {volumes.map((volume) => {
                const attachedHere = volume.attachedAgents.some((agent) => agent.slug === agentSlug)
                const hint = volume.attachedAgents.length > 0
                  ? volume.attachedAgents.map((agent) => agent.name).join(', ')
                  : 'No agents attached'
                return (
                  <div key={volume.id} className="flex items-center gap-1">
                    <button
                      className="flex min-w-0 flex-1 flex-col items-start rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors disabled:opacity-50"
                      disabled={attachedHere}
                      onClick={() => {
                        void onAttach(volume.id)
                        setOpen(false)
                      }}
                    >
                      <span className="truncate w-full text-left">{volume.name}</span>
                      <span className="truncate w-full text-left text-muted-foreground">{hint}</span>
                    </button>
                    {volume.attachedAgents.length === 0 && (
                      <button
                        className="rounded-sm p-1 text-destructive hover:bg-destructive/10"
                        aria-label={`Delete ${volume.name}`}
                        onClick={() => {
                          setPendingDelete(volume)
                          setOpen(false)
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <NewSharedVolumeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={onCreate}
      />

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => { if (!next) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete shared volume</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{pendingDelete?.name}&quot;? This permanently deletes the folder and its files.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) void onDelete(pendingDelete.id)
                setPendingDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function NewSharedVolumeDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const mountName = previewMountName(name)

  const reset = () => {
    setName('')
    setError(null)
    setIsSubmitting(false)
  }

  const handleClose = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const handleCreate = async () => {
    setError(null)
    const parsed = nameSchema.safeParse(name)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Name is required')
      return
    }
    setIsSubmitting(true)
    try {
      await onCreate(parsed.data)
      handleClose(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create shared volume')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent hideClose>
        <DialogHeader>
          <DialogTitle>New shared volume</DialogTitle>
          <DialogDescription>
            Create a shared folder in this workspace. Agents you attach it to can read and write its files.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="shared-volume-name">Name</Label>
          <Input
            id="shared-volume-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Shared notes"
            autoFocus
          />
          {mountName && (
            <p className="text-xs text-muted-foreground font-mono">
              Mounts at /volumes/{mountName}
            </p>
          )}
          {error && (
            <p className="text-xs text-destructive" role="alert">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => handleClose(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleCreate()} disabled={isSubmitting}>
            {isSubmitting ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
