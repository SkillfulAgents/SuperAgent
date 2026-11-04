import { ProviderErrorCard } from '@renderer/components/ui/provider-error-card'

import type { AgentRuntimeErrorPreviewProps } from '../previews'

export function PlatformReconnectRequiredPreview({ error }: AgentRuntimeErrorPreviewProps) {
  return (
    <ProviderErrorCard
      message={error.message}
      presentation={{
        severity: 'error',
        icon: 'info',
        message: 'Your platform sign-in expired or was revoked. [Reconnect in Settings → Platform](/settings/platform).',
      }}
    />
  )
}
