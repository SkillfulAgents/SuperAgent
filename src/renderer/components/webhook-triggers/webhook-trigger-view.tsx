/**
 * Webhook Trigger View
 *
 * Displays details of an active webhook trigger, including the prompt
 * that fires when events occur, related sessions, and a cancel option.
 */



import { Zap, Trash2, Loader2, Settings2 } from 'lucide-react'
import { RelatedSessions } from '@renderer/components/sessions/related-sessions'
import { Button } from '@renderer/components/ui/button'
import {
  useWebhookTrigger,
  useCancelWebhookTrigger,
  useWebhookTriggerSessions,
} from '@renderer/hooks/use-webhook-triggers'
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'

interface WebhookTriggerViewProps {
  triggerId: string
  agentSlug: string
}

export function WebhookTriggerView({ triggerId, agentSlug }: WebhookTriggerViewProps) {
  const { data: trigger, isLoading, error } = useWebhookTrigger(triggerId)
  const { data: sessions = [] } = useWebhookTriggerSessions(triggerId)
  const cancelTrigger = useCancelWebhookTrigger()
  const { handleWebhookTriggerDeleted } = useSelection()
  const { canUseAgent } = useUser()
  const canCancel = canUseAgent(agentSlug)

  const handleCancel = async () => {
    try {
      await cancelTrigger.mutateAsync({ triggerId, agentSlug })
      handleWebhookTriggerDeleted(triggerId)
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

  const formatDate = (date: Date | string | number | null) => {
    if (!date) return 'Never'
    const d = typeof date === 'number' ? new Date(date) : new Date(date)
    return d.toLocaleString()
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Trigger header */}
      <div className="p-6 border-b">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold mb-2">
              {trigger.name || trigger.triggerType}
            </h2>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1">
                <Zap className="h-4 w-4" />
                <span>{trigger.triggerType}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className={`inline-block w-2 h-2 rounded-full ${
                  trigger.status === 'active' ? 'bg-green-500' : 'bg-gray-400'
                }`} />
                <span className="capitalize">{trigger.status}</span>
              </div>
            </div>
          </div>

          {trigger.status === 'active' && canCancel && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Cancel Trigger
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel Webhook Trigger</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to cancel this webhook trigger? It will stop
                    receiving events. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep Trigger</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleCancel}
                    disabled={cancelTrigger.isPending}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {cancelTrigger.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Cancelling...
                      </>
                    ) : (
                      'Cancel Trigger'
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* Trigger details */}
      <div className="flex-1 overflow-auto p-6">
        {/* Fire count */}
        {trigger.fireCount > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Times Fired
            </h3>
            <div className="text-lg">{trigger.fireCount}</div>
          </div>
        )}

        {/* Last fired */}
        {trigger.lastFiredAt && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Last Fired
            </h3>
            <div className="text-sm">{formatDate(trigger.lastFiredAt)}</div>
          </div>
        )}

        {/* Trigger Config */}
        {trigger.triggerConfig && (() => {
          try {
            const config = JSON.parse(trigger.triggerConfig)
            const entries = Object.entries(config).filter(([, v]) => v !== null && v !== undefined && v !== '')
            if (entries.length === 0) return null
            return (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">
                  <span className="flex items-center gap-1">
                    <Settings2 className="h-3.5 w-3.5" />
                    Configuration
                  </span>
                </h3>
                <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                  {entries.map(([key, value]) => (
                    <div key={key} className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground font-mono shrink-0">{key}:</span>
                      <span className="break-all">
                        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          } catch {
            return null
          }
        })()}

        {/* Prompt */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Trigger Prompt
          </h3>
          <div className="border-2 border-dashed border-muted rounded-lg p-4 bg-muted/20">
            <div className="flex items-start gap-2 mb-3 text-sm text-muted-foreground">
              <Zap className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                This prompt will be sent to the agent when the trigger fires,
                along with the webhook payload.
              </span>
            </div>
            <div className="whitespace-pre-wrap text-sm">{trigger.prompt}</div>
          </div>
        </div>

        <RelatedSessions sessions={sessions} formatDate={formatDate} className="mb-6" />

        {/* Created */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Created
          </h3>
          <div className="text-sm">{formatDate(trigger.createdAt)}</div>
        </div>

        {/* Connected Account */}
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Connected Account
          </h3>
          <div className="text-sm text-muted-foreground">
            {trigger.connectedAccountId}
          </div>
        </div>
      </div>
    </div>
  )
}
