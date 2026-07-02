import { Pause } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useUpdateChatIntegration } from '@renderer/hooks/use-chat-integrations'
import {
  type ChatIntegrationState,
  deriveChatIntegrationState,
  CHAT_INTEGRATION_STATE_LABEL,
  CHAT_INTEGRATION_STATE_PILL,
} from '@shared/lib/chat-integrations/utils'
import type { ChatIntegration } from '@shared/lib/db/schema'

// Dot/icon treatment per state (pill colors + labels are shared in utils). Pulse
// marks the in-progress state (Connecting); the settled live state (Listening)
// shows a steady dot — pulse = transitioning, steady = up.
const STATE_DOT: Record<ChatIntegrationState, { dot?: string; pulse?: boolean; pauseIcon?: boolean }> = {
  paused: { pauseIcon: true },
  connecting: { dot: 'bg-green-500', pulse: true },
  working: { dot: 'bg-green-500' },
  error: { dot: 'bg-red-500' },
}

export function IntegrationStatusCard({ integration, connected }: {
  integration: ChatIntegration
  connected?: boolean
}) {
  const updateIntegration = useUpdateChatIntegration()
  const state = deriveChatIntegrationState(integration.status, connected)
  const display = STATE_DOT[state]
  // "On" covers active/error/connecting — anything the user means to be running.
  const isOn = integration.status !== 'paused'

  return (
    <DetailCard
      label="Status"
      headerActions={
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${CHAT_INTEGRATION_STATE_PILL[state]}`}>
            {display.pauseIcon ? (
              <Pause className="h-2.5 w-2.5 fill-current" />
            ) : (
              <span className={`h-1.5 w-1.5 rounded-full ${display.dot} ${display.pulse ? 'animate-pulse' : ''}`} />
            )}
            {CHAT_INTEGRATION_STATE_LABEL[state]}
          </span>
          <Switch
            className="scale-75 origin-right"
            checked={isOn}
            disabled={updateIntegration.isPending}
            aria-label={isOn ? 'Pause integration' : 'Resume integration'}
            onCheckedChange={(next) =>
              updateIntegration.mutate({ id: integration.id, status: next ? 'active' : 'paused' })
            }
          />
        </div>
      }
    />
  )
}
