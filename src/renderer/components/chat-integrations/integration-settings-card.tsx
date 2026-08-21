import { useUpdateChatIntegration, useSetRequireApproval } from '@renderer/hooks/use-chat-integrations'
import { ToggleRow, SessionTimeoutSelect } from './integration-settings-controls'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import type { PublicChatIntegration } from '@shared/lib/chat-integrations/public'

export function IntegrationSettingsCard({ integration, canManageAccess }: {
  integration: PublicChatIntegration
  /** Telegram owner: shows the require-approval gate. */
  canManageAccess?: boolean
}) {
  const updateIntegration = useUpdateChatIntegration()
  const setRequireApproval = useSetRequireApproval()

  return (
    <DetailCard label="Integration Settings">
      {/* -mx-4 cancels the card's px-4 so rows span edge-to-edge with full-width dividers. */}
      <div className="-mx-4 divide-y divide-border/50">
        <SessionTimeoutSelect
          id={`timeout-${integration.id}`}
          value={integration.sessionTimeout ?? null}
          onCommit={(hours) => updateIntegration.mutate({ id: integration.id, sessionTimeout: hours })}
          disabled={updateIntegration.isPending}
          description="Idle time before context resets."
          layout="inline"
        />
        <ToggleRow
          label="Show tool activity"
          helperText="See the agent work in the conversation."
          checked={!!integration.showToolCalls}
          disabled={updateIntegration.isPending}
          onCheckedChange={(checked) =>
            updateIntegration.mutate({ id: integration.id, showToolCalls: checked })
          }
        />
        {canManageAccess && integration.provider === 'telegram' && (
          <ToggleRow
            label="Require approval for new conversations"
            helperText={
              setRequireApproval.isError
                ? 'Could not update. Try again.'
                : integration.requireApproval
                  ? undefined
                  : 'When disabled, this bot is public.'
            }
            checked={!!integration.requireApproval}
            disabled={setRequireApproval.isPending}
            onCheckedChange={(checked) =>
              setRequireApproval.mutate({ id: integration.id, requireApproval: checked })
            }
          />
        )}
        {integration.provider === 'slack' && (() => {
          const settings = integration.settings
          return (
            <>
              <ToggleRow
                label="Only respond when @mentioned"
                helperText="Replies to every message when disabled."
                checked={!!settings.onlyMentioned}
                disabled={updateIntegration.isPending}
                onCheckedChange={(checked) =>
                  updateIntegration.mutate({
                    id: integration.id,
                    config: { onlyMentioned: checked },
                  })
                }
              />
              <ToggleRow
                label="Reply in thread"
                helperText="Keep replies in a thread."
                checked={!!settings.answerInThread}
                disabled={updateIntegration.isPending}
                onCheckedChange={(checked) =>
                  updateIntegration.mutate({
                    id: integration.id,
                    config: { answerInThread: checked, ...(!checked ? { newSessionPerThread: false } : {}) },
                  })
                }
              />
              {!!settings.answerInThread && (
                <ToggleRow
                  label="Separate conversation per thread"
                  helperText="Separate context per thread."
                  checked={!!settings.newSessionPerThread}
                  disabled={updateIntegration.isPending}
                  onCheckedChange={(checked) =>
                    updateIntegration.mutate({
                      id: integration.id,
                      config: { newSessionPerThread: checked },
                    })
                  }
                />
              )}
            </>
          )
        })()}
      </div>
    </DetailCard>
  )
}
