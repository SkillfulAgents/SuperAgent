import { CloudOff } from 'lucide-react'

function extractReadableError(raw: string): string {
  const jsonMatch = raw.match(/\{"type":\s*"error".*?"message":\s*"([^"]+)"\s*\}/)
  if (jsonMatch) {
    const prefix = raw.slice(0, raw.indexOf('{')).trim()
    const msg = jsonMatch[1]
    return prefix ? `${prefix} ${msg}` : msg
  }
  return raw
}

interface ProviderErrorCardProps {
  message: string
  'data-testid'?: string
}

function getHint(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('invalid or revoked') || lower.includes('authentication') || lower.includes('401'))
    return 'Your access token may have expired or been revoked. Please reconnect your platform account in Settings.'
  return 'This error came from the external LLM provider API, not from this application. Check your provider configuration in Settings.'
}

export function ProviderErrorCard({ message, 'data-testid': testId }: ProviderErrorCardProps) {
  const displayMessage = extractReadableError(message)

  return (
    <div
      className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3"
      data-testid={testId ?? 'provider-error-card'}
    >
      <div className="flex items-center gap-2">
        <CloudOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-amber-600 dark:text-amber-400">LLM Provider Error</span>
      </div>
      <p className="mt-1 text-sm text-amber-600/90 dark:text-amber-400/90">{displayMessage}</p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {getHint(message)}
      </p>
    </div>
  )
}
