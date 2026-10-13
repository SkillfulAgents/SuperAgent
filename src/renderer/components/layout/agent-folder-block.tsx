import React, { useState } from 'react'
import { ChevronRight, Folder, Pencil, Plus, Trash2 } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import {
  defaultDropAnimation,
  useDroppable,
  type DropAnimation,
  type DropAnimationKeyframeResolver,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@shared/lib/utils/cn'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { SidebarMenuButton } from '@renderer/components/ui/sidebar'
import {
  containerIdForFolder,
  sortableIdForFolder,
  type AgentFolder,
} from '@renderer/lib/agent-folders'

/**
 * A section-level row of the left nav — a folder header, or "Add section"
 * under the last one: small muted label text with no hover or press fill.
 */
export const SECTION_ROW_CLASS =
  'h-8 gap-1 text-xs font-normal text-sidebar-foreground/50 hover:bg-transparent hover:text-sidebar-foreground/50 active:bg-transparent active:text-sidebar-foreground/50'
/** The icon in a section-level row: a folder's chevron, Add section's +. */
export const SECTION_ICON_CLASS = 'h-3.5 w-3.5 text-muted-foreground'

/**
 * A section header's + (a new agent filed into the section). Its hover fill
 * is a step darker than an agent row's (the Electron vibrancy rows use 6%
 * black, 10% white in dark), so it reads as a button on the row rather than
 * the row.
 */
const HEADER_ACTION_CLASS =
  'absolute top-4 z-10 -translate-y-1/2 rounded p-0.5 text-sidebar-foreground/80 transition-opacity hover:bg-black/10 hover:text-sidebar-foreground dark:hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring'

/**
 * Inline rename for a folder. Mirrors the dashboard rename in `app-sidebar.tsx`
 * — commit on Enter or blur, abandon on Escape — but writes to user settings
 * through the caller rather than hitting an API of its own.
 */
function FolderNameInput({
  currentName,
  onCommit,
  onDone,
}: {
  currentName: string
  onCommit: (name: string) => void
  onDone: () => void
}) {
  const [value, setValue] = useState(currentName)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const settledRef = React.useRef(false)

  React.useEffect(() => {
    inputRef.current?.select()
  }, [])

  const submit = () => {
    if (settledRef.current) return
    settledRef.current = true
    const trimmed = value.trim()
    if (trimmed && trimmed !== currentName) onCommit(trimmed)
    onDone()
  }

  const cancel = () => {
    if (settledRef.current) return
    settledRef.current = true
    onDone()
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') cancel()
      }}
      onBlur={submit}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      autoFocus
      aria-label="Section name"
      data-testid="folder-name-input"
      className="w-full bg-background border border-input rounded px-1 py-0 text-[13px] outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

/**
 * The folder header's interactive row. Memoized because the block around it
 * re-renders on every drag tick (its dnd-kit hooks subscribe to the live drag
 * context) and a Radix context menu is too much tree to rebuild at pointer
 * rate; every prop is stable across ticks except the two booleans that
 * genuinely change what it shows.
 */
const FolderHeader = React.memo(function FolderHeader({
  folder,
  isRoot,
  isCollapsed,
  isDropTarget,
  onToggle,
  onStartRename,
  onDelete,
}: {
  folder: AgentFolder
  isRoot: boolean
  isCollapsed: boolean
  isDropTarget: boolean
  onToggle: () => void
  onStartRename: () => void
  onDelete: () => void
}) {
  // Styled like a section label rather than as a row of the list: small muted
  // text, no icon, no count. The expand/collapse chevron follows the label,
  // shown only while the header row is hovered or focused — the row being the
  // header plus any button overlaid on it, which all carry data-header-zone
  // (see the block) — or while an agent is dragged over it. It is wrapped so
  // the menu button's direct-child svg sizing doesn't reach it.
  // The right edge stays clear for the header's overlaid buttons (pr-8).
  // As a label it has no hover or press fill — the menu button's own are
  // cancelled — except as a drop target, where the fill must survive the
  // pointer being over it. It also opts out of `data-sidebar="menu-button"`:
  // the Electron vibrancy rules in globals.css give every menu button an
  // !important hover fill that the classes here cannot override.
  const header = (
        <SidebarMenuButton
          data-sidebar="folder-header"
          onClick={onToggle}
          aria-expanded={!isCollapsed}
          className={cn(
            SECTION_ROW_CLASS,
            'pr-8',
            isDropTarget &&
              'bg-sidebar-accent text-sidebar-foreground ring-1 ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-foreground'
          )}
          data-testid={`agent-folder-${folder.id}`}
        >
          <span className="truncate">{folder.name}</span>
          <span className="flex shrink-0 items-center">
            <ChevronRight
              aria-hidden
              data-testid={`agent-folder-chevron-${folder.id}`}
              className={cn(
                SECTION_ICON_CLASS,
                'transition-[opacity,transform]',
                isDropTarget
                  ? 'opacity-100'
                  : 'opacity-0 group-has-[[data-header-zone]:hover]/folder-block:opacity-100 group-has-[[data-header-zone]:focus-visible]/folder-block:opacity-100 group-has-[[data-header-zone]_:focus-visible]/folder-block:opacity-100',
                !isCollapsed && 'rotate-90'
              )}
            />
          </span>
        </SidebarMenuButton>
  )

  // The default folder is the fallback bucket — it cannot be renamed or
  // deleted, so it gets no context menu at all.
  if (isRoot) return header

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onStartRename} data-testid="rename-folder-item">
          <Pencil className="h-4 w-4 mr-2" />
          Rename Section
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onClick={onDelete}
          data-testid="delete-folder-item"
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Delete Section
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

/**
 * A folder and the agents inside it, as one row of the left nav's top level.
 *
 * The whole block is the sortable node while only the header carries the drag
 * listeners. That split matters twice over: it keeps every top-level item a
 * single contiguous element, so the vertical sorting strategy measures the list
 * correctly and a folder can be dropped between two unfiled agents; and it
 * leaves the member rows free to start drags of their own, which they could not
 * if the block itself were listening.
 */
export function AgentFolderBlock({
  folder,
  isRoot = false,
  agentCount,
  isCollapsed,
  activeDragType,
  insertEdge,
  initialRenaming,
  onToggle,
  onRename,
  onRenameEnd,
  onDelete,
  onCreateAgent,
  children,
}: {
  folder: AgentFolder
  /** The default "Your Agents" folder: no rename/delete. */
  isRoot?: boolean
  agentCount: number
  isCollapsed: boolean
  /** What kind of thing is currently being dragged, if anything. */
  activeDragType: 'agent' | 'folder' | null
  /** Which edge of this block a dragged folder would land on, if hovered. */
  insertEdge?: 'above' | 'below' | null
  /** Mount straight into rename mode — used by the just-created folder. */
  initialRenaming?: boolean
  onToggle: () => void
  onRename: (name: string) => void
  onRenameEnd?: () => void
  onDelete: () => void
  /** Rendered as a + on the header row: a new agent filed into this folder. */
  onCreateAgent?: () => void
  children: React.ReactNode
}) {
  const [isRenaming, setIsRenaming] = useState(initialRenaming ?? false)
  const startRename = React.useCallback(() => setIsRenaming(true), [])
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: sortableIdForFolder(folder.id),
    data: { type: 'folder', folderId: folder.id },
    disabled: isRenaming,
  })

  const { setNodeRef: setBodyRef, isOver: isBodyOver } = useDroppable({
    id: containerIdForFolder(folder.id),
    // Collapsed: the body is display:none, so its rect would be a phantom.
    // The header stays the way in (drop on it files at the end).
    disabled: isCollapsed,
    data: { type: 'container' },
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    zIndex: isDragging ? 1 : undefined,
  }

  // dnd-kit always includes `aria-disabled` in `attributes` — `false` at rest,
  // `true` while a rename suspends the drag — and React renders boolean aria-*
  // values as literal strings. The header is a live control either way (only
  // its DRAG is ever disabled), so the flag is stripped rather than spread.
  const { 'aria-disabled': dragDisabled, ...handleAttributes } = attributes
  void dragDisabled

  // Dropping an agent on the header files it at the end of the folder, which is
  // the only way into a collapsed one.
  const isAgentTarget = (isOver || isBodyOver) && activeDragType === 'agent'

  return (
    // mt-2: air above each section header. A margin, not padding, so the
    // header's absolutely placed buttons (top-4 = the header's centre) and the
    // insert line keep their offsets from the block's top edge.
    <li ref={setNodeRef} style={style} className="group/folder-block relative mt-2 list-none">
      {insertEdge && !isDragging && (
        // A folder over a folder is a reorder, not a nest — folders do not
        // nest — so it gets an insert line rather than the fill an agent drop
        // gets. The line sits on the edge the drop will actually use: the
        // pointer's half of this block decides above or below, and the drop
        // handler reads the same cue, so the line can never lie about where
        // the folder lands.
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-sidebar-ring',
            insertEdge === 'above' ? '-top-0.5' : '-bottom-0.5'
          )}
          data-edge={insertEdge}
          data-testid={`folder-insert-indicator-${folder.id}`}
        />
      )}

      {isRenaming ? (
        // The input REPLACES the header rather than sitting inside it: a form
        // control nested in a <button> is invalid markup, and clicking it would
        // land on the button and toggle the folder shut mid-edit.
        <div className="flex h-8 items-center rounded-md px-2">
          <FolderNameInput
            currentName={folder.name}
            onCommit={onRename}
            onDone={() => {
              setIsRenaming(false)
              onRenameEnd?.()
            }}
          />
        </div>
      ) : (
        <div ref={setActivatorNodeRef} {...handleAttributes} {...listeners} className="relative" data-header-zone>
          <FolderHeader
            folder={folder}
            isRoot={isRoot}
            isCollapsed={isCollapsed}
            isDropTarget={isAgentTarget}
            onToggle={onToggle}
            onStartRename={startRename}
            onDelete={onDelete}
          />
        </div>
      )}

      {/*
        The + overlays the row as a SIBLING of the drag activator: a button
        cannot nest inside the header <button>, and pressing it must not begin
        the folder's drag. It takes the header's right edge, centred on the
        column the agent rows' status icons sit in (16px in), is always shown
        — it is the folder's own "New Agent" — and gives way to the rename
        input. New sections are made from "Add section" at the end of the
        list, not from a header.
      */}
      {onCreateAgent && !isRenaming && (
        <button
          type="button"
          onClick={onCreateAgent}
          aria-label={`New agent in ${folder.name}`}
          data-header-zone
          title={`New agent in ${folder.name}`}
          data-testid={`new-agent-in-folder-${folder.id}`}
          className={cn(HEADER_ACTION_CLASS, 'right-[7px]')}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}

      {/*
        The body stays MOUNTED while collapsed and hides via the `hidden`
        attribute — unmounting made expanding a large folder a visible hitch
        (~170ms for 80 rows), where the pre-folders sidebar kept every row
        alive. The hidden rows' drag targets need no per-row bookkeeping here,
        but they are NOT free: display:none rects measure 0×0, which the
        containment and overlap detectors can never hit, but DISTANCE-based
        collision (the sidebar's closest-row snap, keyboard coordinate
        getters) happily returns — so the sidebar's collision detection
        filters zero-height rects out of the snap explicitly.
      */}
      <div
          ref={setBodyRef}
          hidden={isCollapsed}
          data-container-id={containerIdForFolder(folder.id)}
          // No indent: rows sit at the same offset as before folders existed,
          // the way they always did under the old "Your Agents" label.
          className={cn(isBodyOver && activeDragType === 'agent' && 'rounded-md bg-sidebar-accent/40')}
        >
          <ul className="flex w-full min-w-0 flex-col gap-2">{children}</ul>
          {agentCount === 0 && (
            // An empty folder has no rows to aim at, so it needs a body with
            // real height or it cannot be dropped into at all.
            <div
              className={cn(
                'mx-1 my-0.5 rounded-md border border-dashed border-sidebar-border px-2 py-1.5 text-[11px] text-muted-foreground/70',
                isBodyOver && 'border-sidebar-ring text-sidebar-foreground'
              )}
              data-testid={`agent-folder-empty-${folder.id}`}
            >
              Drag agents here
            </div>
          )}
        </div>
    </li>
  )
}

/**
 * Where the overlay flies once released. The default keyframes aim at the
 * dropped row's post-drop rect — but a row filed into a COLLAPSED folder sits
 * in the folder's `hidden` body, and a hidden node measures 0×0 at the
 * viewport origin, so the overlay would fly to the window's top-left corner.
 * A landing spot with no visible rect gets a fade-out in place instead.
 */
export const overlayDropKeyframes: DropAnimationKeyframeResolver = (params) => {
  const { width, height } = params.active.rect
  if (!width && !height) {
    const transform = CSS.Transform.toString(params.transform.initial)
    return [
      { transform, opacity: 1 },
      { transform, opacity: 0 },
    ]
  }
  return defaultDropAnimation.keyframes(params)
}

export const agentDropAnimation: DropAnimation = {
  ...defaultDropAnimation,
  keyframes: overlayDropKeyframes,
}

/** The row that follows the cursor during a drag. */
export function AgentDragOverlayRow({ label, isFolder }: { label: string; isFolder: boolean }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-sidebar-border bg-sidebar px-2 py-1.5 text-[13px] shadow-lg"
      data-testid="agent-drag-overlay"
    >
      {isFolder && <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <span className="truncate">{label}</span>
    </div>
  )
}
