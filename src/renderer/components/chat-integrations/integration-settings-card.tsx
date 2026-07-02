import { useUpdateChatIntegration, useSetRequireApproval } from '@renderer/hooks/use-chat-integrations'
import { parseChatIntegrationConfig, type SlackConfig } from '@shared/lib/chat-integrations/config-schema'
import { ToggleRow, SessionTimeoutSelect } from './integration-settings-controls'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import type { ChatIntegration } from '@shared/lib/db/schema'

export function IntegrationSettingsCard({ integration, canManageAccess }: {
  integration: ChatIntegration
  /** Telegram owner: shows the require-approval gate. */
  canManageAccess?: boolean
}) {
  const updateIntegration = useUpdateChatIntegration()
  const setRequireApproval = useSetRequireApproval()

  return (
    <DetailCard label="Conversation Settings">
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
          const config = parseChatIntegrationConfig('slack', integration.config) as SlackConfig | null
          if (!config) return null
          return (
            <>
              <ToggleRow
                label="Only respond when @mentioned"
                helperText="Replies to every message when disabled."
                checked={!!config.onlyMentioned}
                disabled={updateIntegration.isPending}
                onCheckedChange={(checked) =>
                  updateIntegration.mutate({
                    id: integration.id,
                    config: { ...config, onlyMentioned: checked },
                  })
                }
              />
              <ToggleRow
                label="Reply in thread"
                helperText="Keep replies in a thread."
                checked={!!config.answerInThread}
                disabled={updateIntegration.isPending}
                onCheckedChange={(checked) =>
                  updateIntegration.mutate({
                    id: integration.id,
                    config: { ...config, answerInThread: checked, ...(!checked ? { newSessionPerThread: false } : {}) },
                  })
                }
              />
              {!!config.answerInThread && (
                <ToggleRow
                  label="Separate conversation per thread"
                  helperText="Separate context per thread."
                  checked={!!config.newSessionPerThread}
                  disabled={updateIntegration.isPending}
                  onCheckedChange={(checked) =>
                    updateIntegration.mutate({
                      id: integration.id,
                      config: { ...config, newSessionPerThread: checked },
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
