import { CloudOff } from 'lucide-react'

interface ProviderErrorCardProps {
  message: string
  'data-testid'?: string
}

export function ProviderErrorCard({ message, 'data-testid': testId }: ProviderErrorCardProps) {
  return (
    <div
      className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3"
      data-testid={testId ?? 'provider-error-card'}
    >
      <div className="flex items-center gap-2">
        <CloudOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-amber-600 dark:text-amber-400">LLM Provider Error</span>
      </div>
      <p className="mt-1 text-sm text-amber-600/90 dark:text-amber-400/90">{message}</p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        This error came from the external LLM provider API, not from this application. Check your API key and provider configuration in settings.
      </p>
    </div>
  )
}
