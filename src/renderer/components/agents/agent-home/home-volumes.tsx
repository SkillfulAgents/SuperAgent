import { useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { VolumeIcon } from '@renderer/components/volumes/volume-icon'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
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
  MoreVertical,
  Pencil,
  FolderOpen,
  Copy,
  Trash2,
  Lock,
  Check,
  Plus,
  Loader2,
  RefreshCw,
  ChevronDown,
} from 'lucide-react'
import { HomeCollapsible } from './home-collapsible'
import { useVolumesManager } from '@renderer/hooks/use-mounts'
import { openableProps } from '@renderer/lib/openable'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { VolumeSettingsDialog } from '@renderer/components/volumes/volume-settings-dialog'
import { InlineEditableTitle, type InlineEditableTitleHandle } from '@renderer/components/ui/inline-editable-title'
import { useSaveVolumeDefinition } from '@renderer/hooks/use-volume-definitions'
import { mountPathOf } from '@shared/lib/volumes/base-mountable-volume'
import { parseVolumeName } from '@renderer/components/volumes/volume-details-schema'
import { VolumeStatusBadge } from '../volume-status-badge'
import type { MountSummaryWithHealth, VolumeDefinitionSummary } from '@shared/lib/types/mount'

interface HomeVolumesProps {
  agentSlug: string
  className?: string
}

export function HomeVolumes({ agentSlug, className }: HomeVolumesProps) {
  const volumes = useVolumesManager(agentSlug)
  const [showNewVolume, setShowNewVolume] = useState(false)

  // Saved sources can be attached from a browser or cloud workspace, too.
  if (!volumes.canAddMount && volumes.mounts.length === 0 && !volumes.operationError) return null

  return (
    <HomeCollapsible title="Drives" className={className}>
      {volumes.mounts.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {volumes.mounts.map((mount) => (
            <VolumeRow
              key={mount.id}
              mount={mount}
              definition={volumes.definitions.find(volume => volume.id === mount.volumeId)}
              agentSlug={agentSlug}
              onRemove={() => volumes.handleRemove(mount.id)}
              onSetReadOnly={(readOnly) => volumes.handleSetReadOnly(mount.id, readOnly)}
              isRemovingMount={volumes.isRemovingMount}
              isUpdatingMount={volumes.isUpdatingMount}
              canRemove={volumes.canModifyMounts && !mount.global}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No drives yet</p>
          <p className="text-xs mt-1">Add a saved drive{volumes.canCreateMount ? ' or create a new one' : ''} to give this agent read/write access.</p>
        </div>
      )}

      <div className="mt-3 px-4">
        {volumes.operationError && <p role="alert" className="mb-2 text-xs text-destructive">{volumes.operationError}</p>}
        {volumes.pendingRestart ? (
          <div className="flex flex-col gap-1 rounded-lg bg-orange-50 dark:bg-orange-950/30 p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-orange-600 dark:text-orange-400 flex-1">
                Restart your agent to apply recent changes.
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="text-orange-600 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/40 hover:text-orange-700 dark:hover:text-orange-300"
                onClick={volumes.handleRestart}
                disabled={volumes.isRestarting}
              >
                <RefreshCw className={`${volumes.isRestarting ? 'animate-spin' : ''}`} />
                {volumes.isRestarting ? 'Restarting...' : 'Restart'}
              </Button>
            </div>
          </div>
        ) : null}
        {volumes.canAddMount && (
          <div className="flex justify-end">
            {volumes.definitions.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={volumes.isAddingMount || volumes.isLoading} data-testid="add-mount-menu">
                    {volumes.isAddingMount ? <Loader2 className="animate-spin" /> : <Plus />}
                    Add Drive <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel>Saved drives</DropdownMenuLabel>
                  {volumes.definitions.map(volume => {
                    const attached = volumes.mounts.some(m => m.volumeId === volume.id)
                    return (
                      <DropdownMenuItem key={volume.id} disabled={attached} onSelect={() => { void volumes.handleAttach(volume.id) }}>
                        <VolumeIcon type={volume.type} className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{volume.name}</span>
                          {(volume.sourceLabel ?? volume.hostPath) && <span className="block truncate text-xs text-muted-foreground">{volume.sourceLabel ?? volume.hostPath}</span>}
                        </span>
                        {attached && <span className="text-xs text-muted-foreground">Added</span>}
                      </DropdownMenuItem>
                    )
                  })}
                  {volumes.canCreateMount && <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setShowNewVolume(true)}><Plus className="h-4 w-4" />New Drive</DropdownMenuItem>
                  </>}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setShowNewVolume(true)} disabled={volumes.isAddingMount || volumes.isLoading}>
                {volumes.isAddingMount ? <Loader2 className="animate-spin" /> : <Plus />} Add Drive
              </Button>
            )}
          </div>
        )}
      </div>
      {showNewVolume && <VolumeSettingsDialog
        attachToAgent
        onSave={volumes.handleCreateMount}
        onClose={() => setShowNewVolume(false)}
      />}
    </HomeCollapsible>
  )
}

function getFileManagerLabel(): string {
  const platform = window.electronAPI?.platform
  if (platform === 'win32') return 'Explorer'
  if (platform === 'darwin') return 'Finder'
  return 'Files'
}

interface VolumeRowProps {
  agentSlug: string
  mount: MountSummaryWithHealth
  definition?: VolumeDefinitionSummary
  onRemove: () => void
  onSetReadOnly: (readOnly: boolean) => void
  isRemovingMount: boolean
  isUpdatingMount: boolean
  canRemove: boolean
}

function VolumeRow({ mount, definition, agentSlug, onRemove, onSetReadOnly, isRemovingMount, isUpdatingMount, canRemove }: VolumeRowProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const titleRef = useRef<InlineEditableTitleHandle>(null)
  useLayoutEffect(() => { if (isRenaming) titleRef.current?.startEditing() }, [isRenaming])
  const navigate = useNavigate()
  const save = useSaveVolumeDefinition()
  const fileManagerLabel = getFileManagerLabel()
  // `hostPath` is a path on whichever machine runs the agent. Opening it in the
  // file manager only works when that machine is this one; against a cloud
  // workspace it either fails or, worse, opens a same-named folder of yours.
  const { hostPath } = mount
  const subtitle = mount.name === mount.volumeName ? mount.sourceLabel ?? hostPath : mountPathOf(mount.name)
  const canOpenInFileManager = canUseHostFeatures() && hostPath !== null

  const handleOpenInFinder = () => {
    if (!canOpenInFileManager) return
    void window.electronAPI?.showInFolder(hostPath)
  }

  const handleCopyPath = () => {
    if (hostPath) void navigator.clipboard.writeText(hostPath)
  }

  const canOpen = definition !== undefined && !isRenaming
  const openSettings = () => {
    void navigate({ to: '/settings/$tab', params: { tab: 'volumes' }, search: { volume: mount.volumeId, source: 'home', from: `/agents/${encodeURIComponent(agentSlug)}` } })
  }

  const handleDelete = () => {
    onRemove()
    setShowDeleteDialog(false)
  }

  return (
    <>
      <div
        {...(canOpen ? { ...openableProps(openSettings), 'aria-label': `Open ${mount.volumeName} drive settings` } : {})}
        className={`group relative py-3 px-4 transition-colors ${canOpen ? 'hover:bg-muted/50 cursor-pointer' : ''}`}
      >
        <div className="flex items-center gap-2">
          <VolumeIcon type={mount.type} className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          {isRenaming ? (
            <InlineEditableTitle
              ref={titleRef}
              value={mount.volumeName}
              canEdit
              isSaving={save.isPending}
              onSave={async name => { await save.mutateAsync({ id: mount.volumeId, name: parseVolumeName(name) }) }}
              onEditEnd={() => setIsRenaming(false)}
              onError={error => toast.error('Failed to rename drive', { description: error instanceof Error ? error.message : 'Please try again.' })}
              displayClassName="text-xs font-medium"
              inputClassName="h-7 text-xs md:text-xs"
              editContainerClassName="mr-7"
              saveButtonClassName="h-7 w-7"
              ariaLabel="Rename drive"
              saveAriaLabel="Save name"
              inputTestId="volume-row-name-input"
            />
          ) : <>
            <span className="text-xs font-medium truncate">{mount.volumeName}</span>
            <VolumeStatusBadge health={mount.health} />
            {mount.readOnly && (
              <span className="inline-flex items-center gap-1 text-2xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground">
                <Lock className="h-2.5 w-2.5" />
                Read only
              </span>
            )}
            {mount.global && <span className="inline-flex items-center text-2xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground">Global</span>}
          </>}
        </div>
        {subtitle && (
          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1 font-mono" title={subtitle}>
            {subtitle}
          </div>
        )}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100 transition-opacity">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label="Drive actions"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1" onClick={(e) => e.stopPropagation()}>
              {canOpenInFileManager && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleOpenInFinder()
                    setMenuOpen(false)
                  }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Open in {fileManagerLabel}
                </button>
              )}
              {hostPath && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCopyPath()
                    setMenuOpen(false)
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy path
                </button>
              )}
              {definition?.canManage && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen(false)
                    setIsRenaming(true)
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Rename
                </button>
              )}
              {canRemove && (
                <button
                  role="switch"
                  aria-checked={mount.readOnly}
                  disabled={isUpdatingMount}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors disabled:opacity-50"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSetReadOnly(!mount.readOnly)
                    setMenuOpen(false)
                  }}
                >
                  <Lock className="h-3.5 w-3.5" />
                  Read only
                  {mount.readOnly && <Check className="ml-auto h-3.5 w-3.5" />}
                </button>
              )}
              {canRemove && <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDeleteDialog(true)
                  setMenuOpen(false)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove from Agent
              </button>}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from Agent</AlertDialogTitle>
            <AlertDialogDescription>
              Remove &quot;{mount.volumeName}&quot; from this agent? The saved drive and its files will remain available. Restart the agent to remove the drive from its filesystem.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Drive</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isRemovingMount}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemovingMount ? 'Removing...' : 'Remove from Agent'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
