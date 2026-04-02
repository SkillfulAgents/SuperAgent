import { useState } from 'react'
import {
  Blocks,
  Check,
  MoreVertical,
  Pencil,
  X,
} from 'lucide-react'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { ToolPolicySummaryPill } from '@renderer/components/ui/tool-policy-summary-pill'
import { cn } from '@shared/lib/utils/cn'

export interface RemoteMcpServer {
  id: string
  name: string
  url: string
  authType: string
  status: string
  tools: Array<{ name: string; description?: string }>
}

export function getMcpServiceKey(serverUrl: string) {
  const commonServer = COMMON_MCP_SERVERS.find((server) => server.url === serverUrl)
  if (commonServer?.slug) return commonServer.slug

  try {
    return new URL(serverUrl).hostname
  } catch {
    return serverUrl
  }
}

export function McpSourceIcon({ slug }: { slug: string }) {
  const [failed, setFailed] = useState(false)

  if (!slug || failed) {
    return <Blocks className="h-5 w-5 text-muted-foreground/70" />
  }

  return (
    <img
      src={`${import.meta.env.BASE_URL}service-icons/${slug}.svg`}
      alt=""
      aria-hidden="true"
      className="h-6 w-6 object-contain"
      onError={() => setFailed(true)}
    />
  )
}

export interface McpServerCardProps {
  server: RemoteMcpServer
  // Selection
  selected?: boolean
  onToggle?: () => void
  // Editing (rename)
  isEditing: boolean
  editName: string
  onEditNameChange: (name: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  isSavingRename: boolean
  // Menu
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onStartRename: () => void
  // Policy
  onOpenPolicies: () => void
  // State
  disabled?: boolean
}

export function McpServerCard({
  server,
  selected,
  onToggle,
  isEditing,
  editName,
  onEditNameChange,
  onSaveEdit,
  onCancelEdit,
  isSavingRename,
  menuOpen,
  onMenuOpenChange,
  onStartRename,
  onOpenPolicies,
  disabled,
}: McpServerCardProps) {
  const serverSlug = COMMON_MCP_SERVERS.find((commonServer) => commonServer.url === server.url)?.slug || ''

  const renameMenu = (
    <Popover
      open={menuOpen}
      onOpenChange={onMenuOpenChange}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 shrink-0 p-0 text-muted-foreground/70 hover:bg-transparent hover:text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation()
          }}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-32 p-1"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start gap-2 text-foreground hover:bg-muted"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onMenuOpenChange(false)
            onStartRename()
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
          Rename
        </Button>
      </PopoverContent>
    </Popover>
  )

  const editChildren = (
    <>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
        <McpSourceIcon slug={serverSlug} />
      </div>
      <Input
        value={editName}
        onChange={(e) => onEditNameChange(e.target.value)}
        className="h-7 max-w-[296px] flex-1 text-sm"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSaveEdit()
          if (e.key === 'Escape') onCancelEdit()
        }}
      />
      <Button
        size="sm"
        variant="default"
        className="h-6 shrink-0 bg-foreground px-2 text-xs text-background hover:bg-foreground/90"
        onClick={onSaveEdit}
        loading={isSavingRename}
      >
        <Check className="h-3 w-3" />
        <span>Update</span>
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={onCancelEdit}
      >
        <X className="h-3 w-3" />
        <span>Cancel</span>
      </Button>
    </>
  )

  if (isEditing) {
    // Both the list-item variant and the single-card variant render
    // the same edit UI: a flex row with gap-2 inside a rounded border card.
    // The list-item variant (onToggle present) puts flex directly on the outer div;
    // the single-card variant wraps the flex row in an inner div.
    if (onToggle) {
      return (
        <div className="flex items-center gap-2 rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
          {editChildren}
        </div>
      )
    }

    return (
      <div className="rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
        <div className="flex items-center gap-2">
          {editChildren}
        </div>
      </div>
    )
  }

  const displayContent = (
    <>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
        <McpSourceIcon slug={serverSlug} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <p className="truncate text-sm font-normal text-foreground">
            {server.name}
          </p>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {server.url}
        </p>
      </div>
      <div className="ml-3 flex shrink-0 items-center gap-2">
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
        <span onClick={(e) => e.stopPropagation()}>
          <ToolPolicySummaryPill
            mcpId={server.id}
            onClick={onOpenPolicies}
          />
        </span>
        {renameMenu}
      </div>
    </>
  )

  // Selectable variant (used in lists with multiple servers)
  if (onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={cn(
          'group flex w-full items-center gap-3 rounded-[12px] border px-4 py-3 text-left transition-colors',
          selected
            ? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40'
            : 'border-border bg-white hover:bg-muted/40 dark:bg-background',
          disabled && 'cursor-not-allowed opacity-70'
        )}
      >
        {displayContent}
      </button>
    )
  }

  // Static display variant (single selected server)
  return (
    <div className="group rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
      <div className="flex items-center gap-2">
        {displayContent}
      </div>
    </div>
  )
}
