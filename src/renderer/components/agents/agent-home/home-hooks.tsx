import { useState } from 'react'
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
import { MoreVertical, Webhook, Trash2, TriangleAlert } from 'lucide-react'
import { HomeCollapsible } from './home-collapsible'
import { useAgentHooks, useRemoveAgentHook } from '@renderer/hooks/use-agent-hooks'
import { BLOCKING_HOOK_EVENTS, type AgentHook } from '@shared/lib/services/agent-hooks-schema'

interface HomeHooksProps {
  agentSlug: string
  isOwner: boolean
  className?: string
}

/**
 * Claude Code hooks configured in the agent's workspace settings file. Agents
 * can install these themselves, and a UserPromptSubmit hook can silently block
 * every incoming message — so any configured hook is worth showing. Hidden
 * entirely when none are configured (the overwhelmingly common case).
 */
export function HomeHooks({ agentSlug, isOwner, className }: HomeHooksProps) {
  const { data: hooks } = useAgentHooks(agentSlug)
  const removeHook = useRemoveAgentHook(agentSlug)

  if (!hooks || hooks.length === 0) return null

  const hasBlockingHook = hooks.some((h) => BLOCKING_HOOK_EVENTS.has(h.event))

  return (
    <HomeCollapsible title="Hooks" className={className}>
      {hasBlockingHook && (
        <div className="mt-2 mx-4 flex items-start gap-2 rounded-lg bg-amber-500/10 p-2.5" data-testid="home-hooks-warning">
          <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-xs text-amber-700 dark:text-amber-400">
            A UserPromptSubmit hook runs before every message and can block it — including yours.
            If this agent stops responding, remove the hook.
          </span>
        </div>
      )}
      <div className="mt-2 divide-y divide-border/50">
        {hooks.map((hook, index) => (
          <HookRow
            key={`${hook.event}-${hook.matcher ?? ''}-${hook.command ?? ''}-${index}`}
            hook={hook}
            isOwner={isOwner}
            onRemove={() => {
              if (!hook.command) return
              removeHook.mutate({
                event: hook.event,
                command: hook.command,
                ...(hook.matcher !== undefined && { matcher: hook.matcher }),
              })
            }}
            isRemoving={removeHook.isPending}
          />
        ))}
      </div>
      <p className="mt-2 px-4 text-xs text-muted-foreground">
        Hooks are shell commands from this agent&apos;s workspace settings, run automatically at
        lifecycle events. They are usually written by the agent itself.
      </p>
    </HomeCollapsible>
  )
}

interface HookRowProps {
  hook: AgentHook
  isOwner: boolean
  onRemove: () => void
  isRemoving: boolean
}

function HookRow({ hook, isOwner, onRemove, isRemoving }: HookRowProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const isBlocking = BLOCKING_HOOK_EVENTS.has(hook.event)

  const handleDelete = () => {
    onRemove()
    setShowDeleteDialog(false)
  }

  return (
    <>
      <div className="group relative py-3 px-4 hover:bg-muted/50 transition-colors" data-testid="home-hooks-row">
        <div className="flex items-center gap-2">
          {isBlocking ? (
            <TriangleAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          ) : (
            <Webhook className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-xs font-medium truncate">{hook.event}</span>
          {hook.matcher && (
            <span className="text-2xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground truncate" title={hook.matcher}>
              {hook.matcher}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1 font-mono" title={hook.command}>
          {hook.command || '(no command)'}
        </div>
        {isOwner && hook.command && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-6 w-6"
                  aria-label="Hook actions"
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-40 p-1">
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={() => {
                    setShowDeleteDialog(true)
                    setMenuOpen(false)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove Hook
                </button>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Hook</AlertDialogTitle>
            <AlertDialogDescription>
              Remove the {hook.event} hook from this agent&apos;s settings? The command it runs
              will no longer execute. Other settings are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Hook</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isRemoving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemoving ? 'Removing...' : 'Remove Hook'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
