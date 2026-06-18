/**
 * Webhook Trigger View
 *
 * Displays details of a webhook trigger: the instructions sent when the
 * trigger fires, run history, status toggle, and a delete option.
 */

import { useEffect, useMemo, useState } from 'react'
import { Trash2, Loader2, AlertTriangle, Settings as SettingsIcon, Pencil } from 'lucide-react'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  useWebhookTrigger,
  useCancelWebhookTrigger,
  useWebhookTriggerSessions,
  usePauseWebhookTrigger,
  useResumeWebhookTrigger,
  useUpdateWebhookTriggerPrompt,
  useUpdateWebhookTriggerRuntimeOptions,
} from '@renderer/hooks/use-webhook-triggers'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { useSettings } from '@renderer/hooks/use-settings'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
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
import { SettingsPageContainer, PageTitle } from '@renderer/components/layout/settings-page'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { StatusToggle } from '@renderer/components/triggers/status-toggle'
import { RunHistorySection } from '@renderer/components/triggers/run-history-section'
import { CollapsiblePromptText } from '@renderer/components/triggers/collapsible-prompt-text'
import { EditPromptDialog } from '@renderer/components/triggers/edit-prompt-dialog'
import { RuntimeOptionsCard } from '@renderer/components/triggers/runtime-options-card'

interface WebhookTriggerViewProps {
  triggerId: string
  agentSlug: string
}

export function WebhookTriggerView({ triggerId, agentSlug }: WebhookTriggerViewProps) {
  const { data: trigger, isLoading, error } = useWebhookTrigger(triggerId)
  const { data: sessions = [] } = useWebhookTriggerSessions(triggerId)
  const cancelTrigger = useCancelWebhookTrigger()
  const pauseTrigger = usePauseWebhookTrigger()
  const resumeTrigger = useResumeWebhookTrigger()
  const updatePrompt = useUpdateWebhookTriggerPrompt()
  const updateRuntimeOptions = useUpdateWebhookTriggerRuntimeOptions()
  const navigate = useNavigate()
  const { canUseAgent } = useUser()
  const { data: settings } = useSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const canCancel = canUseAgent(agentSlug)

  // Canonicalize: triggers are addressed globally by id, so /agents/<wrong>/webhooks/<id>
  // would render this trigger under the wrong agent's shell (mismatched chrome,
  // back-links, and canUseAgent gating). Redirect to the trigger's true agent.
  useEffect(() => {
    if (trigger && trigger.agentSlug !== agentSlug) {
      void navigate({
        to: '/agents/$slug/webhooks/$webhookId',
        params: { slug: trigger.agentSlug, webhookId: triggerId },
        replace: true,
      })
    }
  }, [trigger, agentSlug, triggerId, navigate])

  const isActive = trigger?.status === 'active' || trigger?.status === 'paused'
  const isPaused = trigger?.status === 'paused'
  const hasLocalComposioKey = settings?.apiKeyStatus?.composio?.isConfigured ?? false
  const isPlatformConnected = platformAuth?.connected ?? false

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [editPromptOpen, setEditPromptOpen] = useState(false)
  const [editPromptError, setEditPromptError] = useState<string | null>(null)
  const canEditPrompt = canCancel && trigger?.status !== 'cancelled'

  const handleSavePrompt = (newPrompt: string) => {
    if (!trigger) return
    setEditPromptError(null)
    updatePrompt.mutate(
      { triggerId: trigger.id, agentSlug, prompt: newPrompt },
      {
        onSuccess: () => setEditPromptOpen(false),
        onError: (err) => setEditPromptError(err instanceof Error ? err.message : 'Failed to update prompt'),
      },
    )
  }

  const parsedConfigEntries = useMemo<[string, unknown][]>(() => {
    if (!trigger?.triggerConfig) return []
    try {
      const config = JSON.parse(trigger.triggerConfig) as Record<string, unknown>
      return Object.entries(config).filter(
        ([, v]) => v !== null && v !== undefined && v !== '',
      )
    } catch {
      return []
    }
  }, [trigger?.triggerConfig])

  const handleCancel = async () => {
    try {
      await cancelTrigger.mutateAsync({ id: triggerId, agentSlug })
      // Deleting the trigger we're viewing → up-nav to the agent home (the
      // webhook route no longer resolves).
      void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
    } catch (err) {
      console.error('Failed to cancel webhook trigger:', err)
    }
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading webhook trigger...
      </div>
    )
  }

  if (error || !trigger) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive">
        Failed to load webhook trigger
      </div>
    )
  }

  // Mismatched shell → the effect above is redirecting; don't render B's trigger
  // (or its wrong-slug nested fetches) under A's chrome in the meantime.
  if (trigger.agentSlug !== agentSlug) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading webhook trigger...
      </div>
    )
  }

  const formatDate = (date: Date | string | number | null) => {
    if (!date) return 'Never'
    const d = typeof date === 'number' ? new Date(date) : new Date(date)
    return d.toLocaleString()
  }

  const formatDateOnly = (date: string) => new Date(date).toLocaleDateString()
  const formatTimeOnly = (date: string) => new Date(date).toLocaleTimeString()

  const headerActions = isActive && canCancel ? (
    <div className="flex items-center gap-2">
      <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Webhook settings"
            className="text-muted-foreground"
          >
            <SettingsIcon className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-1">
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            onClick={() => {
              setSettingsOpen(false)
              setDeleteDialogOpen(true)
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete Webhook
          </button>
        </PopoverContent>
      </Popover>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Webhook</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this webhook? It will stop receiving events. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Webhook</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              disabled={cancelTrigger.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelTrigger.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete Webhook'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  ) : null

  return (
    <SettingsPageContainer fullScreen>
      <PageTitle
        title={trigger.name || trigger.triggerType}
        back={{
          onClick: () => {
            void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
          },
          testId: 'webhook-trigger-back-button',
        }}
        actions={headerActions}
      />

      {isActive && !isPlatformConnected && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 !text-amber-600 dark:!text-amber-400" />
          <AlertDescription>
            Webhook triggers require a platform connection. Connect to the platform in Settings to enable triggers.
          </AlertDescription>
        </Alert>
      )}

      {isActive && isPlatformConnected && hasLocalComposioKey && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 !text-amber-600 dark:!text-amber-400" />
          <AlertDescription>
            Webhook triggers require platform-managed Composio and will not fire while using a personal Composio API key.
            Remove your personal key in Settings → Account Provider to restore trigger functionality.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-y-6 lg:gap-x-10 lg:gap-y-0">
        {/* Run History (left, 2/3) */}
        <div className="order-2 lg:order-1">
          <RunHistorySection
            sessions={sessions}
            agentSlug={agentSlug}
            formatDate={formatDateOnly}
            formatSubtext={formatTimeOnly}
            emptyMessage="No runs yet. Sessions will appear here once this trigger fires."
          />
        </div>

        {/* Detail cards (right, 1/3) */}
        <div className="space-y-3 order-1 lg:order-2">
          <DetailCard
            label="Instructions"
            headerActions={canEditPrompt ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Edit instructions"
                className="h-7 w-7 text-muted-foreground"
                onClick={() => setEditPromptOpen(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            ) : undefined}
          >
            <CollapsiblePromptText text={trigger.prompt} />
          </DetailCard>

          <DetailCard
            label="Details"
            headerActions={
              <StatusToggle
                status={trigger.status}
                isActive={isActive}
                isPaused={isPaused}
                disabled={pauseTrigger.isPending || resumeTrigger.isPending}
                canToggle={canCancel}
                onToggle={(next) => {
                  if (next) {
                    resumeTrigger.mutate({ triggerId, agentSlug })
                  } else {
                    pauseTrigger.mutate({ triggerId, agentSlug })
                  }
                }}
                ariaLabelResume="Resume trigger"
                ariaLabelPause="Pause trigger"
              />
            }
            footer={<>Created {formatDate(trigger.createdAt)}</>}
          >
            <dl className="space-y-4">
              <div>
                <dt className="text-xs text-muted-foreground">Webhook Trigger</dt>
                <dd className="text-xs font-normal lowercase">{trigger.triggerType}</dd>
              </div>
              {(trigger.fireCount > 0 || trigger.lastFiredAt) && (
                <div className="flex gap-8">
                  {trigger.fireCount > 0 && (
                    <div>
                      <dt className="text-xs text-muted-foreground">Times Fired</dt>
                      <dd className="text-xs font-normal">{trigger.fireCount}</dd>
                    </div>
                  )}
                  {trigger.lastFiredAt && (
                    <div>
                      <dt className="text-xs text-muted-foreground">Last Fired</dt>
                      <dd className="text-xs font-normal">{formatDate(trigger.lastFiredAt)}</dd>
                    </div>
                  )}
                </div>
              )}
              <div>
                <dt className="text-xs text-muted-foreground">Connected Account</dt>
                <dd className="text-xs font-normal break-all">{trigger.connectedAccountId}</dd>
              </div>
            </dl>
          </DetailCard>

          <RuntimeOptionsCard
            model={trigger.model ?? null}
            effort={trigger.effort ?? null}
            disabled={!canCancel || !isActive}
            onUpdate={(options) => {
              updateRuntimeOptions.mutate({ triggerId, agentSlug, ...options })
            }}
          />

          {parsedConfigEntries.length > 0 && (
            <DetailCard label="Configuration">
              <dl className="space-y-4">
                {parsedConfigEntries.map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-xs text-muted-foreground font-mono">{key}</dt>
                    <dd className="text-xs font-normal break-all">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </DetailCard>
          )}
        </div>
      </div>

      <EditPromptDialog
        open={editPromptOpen}
        onOpenChange={(open) => {
          setEditPromptOpen(open)
          if (!open) setEditPromptError(null)
        }}
        initialPrompt={trigger.prompt}
        title="Edit Instructions"
        description="Update the instructions sent to the agent when this trigger fires."
        isSaving={updatePrompt.isPending}
        errorMessage={editPromptError}
        onSave={handleSavePrompt}
      />
    </SettingsPageContainer>
  )
}
