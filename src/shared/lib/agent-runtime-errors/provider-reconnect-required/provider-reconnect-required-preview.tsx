import { PROVIDER_SIGN_IN_EXPIRED } from '../../../../../agent-container/src/credential-refresh-error'
import { ProviderErrorCard } from '@renderer/components/ui/provider-error-card'

import type { AgentRuntimeErrorPreviewProps } from '../previews'

export function ProviderReconnectRequiredPreview({ error }: AgentRuntimeErrorPreviewProps) {
  return (
    <ProviderErrorCard
      message={error.message}
      presentation={{
        severity: 'error',
        icon: 'info',
        message: `${PROVIDER_SIGN_IN_EXPIRED} [Reconnect in Settings → Model Providers](/settings/llm).`,
      }}
      dismissible
    />
  )
}
