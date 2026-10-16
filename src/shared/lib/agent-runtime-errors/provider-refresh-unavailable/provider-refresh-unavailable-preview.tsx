import { ProviderErrorCard } from '@renderer/components/ui/provider-error-card'

import type { AgentRuntimeErrorPreviewProps } from '../previews'

export function ProviderRefreshUnavailablePreview({ error }: AgentRuntimeErrorPreviewProps) {
  return (
    <ProviderErrorCard
      message={error.message}
      presentation={{ severity: 'warning', icon: 'triangle-alert', message: error.message }}
      dismissible
      showDefaultHint={false}
    />
  )
}
