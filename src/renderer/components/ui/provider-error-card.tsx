import { RequestError } from '@renderer/components/messages/request-error'

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

/**
 * A provider-side failure, in the app's one error treatment (RequestError — the
 * same banner the setup wizard and the settings forms use). What makes it a
 * PROVIDER error is the hint underneath, not a palette of its own.
 */
export function ProviderErrorCard({ message, 'data-testid': testId }: ProviderErrorCardProps) {
  return (
    <RequestError
      label="LLM Provider Error"
      message={extractReadableError(message)}
      hint={getHint(message)}
      // Opaque in dark too: these sit in the overlay footer with the transcript
      // scrolling behind them, where the shared banner's translucent dark fill
      // would let the messages show through.
      className="mt-0 dark:bg-red-950"
      data-testid={testId ?? 'provider-error-card'}
    />
  )
}
