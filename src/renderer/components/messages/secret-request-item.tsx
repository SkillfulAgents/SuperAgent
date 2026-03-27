import { apiFetch } from '@renderer/lib/api'

import { useState } from 'react'
import { Key, Eye, EyeOff, Check, Loader2, Globe } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { DeclineButton } from './decline-button'
import { RequestTitleChip } from './request-title-chip'
import { cn } from '@shared/lib/utils/cn'

interface SecretRequestItemProps {
  toolUseId: string
  secretName: string
  reason?: string
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'provided' | 'declined' | 'fetch-requested'

export function SecretRequestItem({
  toolUseId,
  secretName,
  reason,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: SecretRequestItemProps) {
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)

  const handleProvide = async () => {
    if (!value.trim()) return

    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/provide-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolUseId,
          secretName,
          value: value.trim(),
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to provide secret')
      }

      setStatus('provided')
      onComplete()
    } catch (err: any) {
      setError(err.message || 'Failed to provide secret')
      setStatus('pending')
    }
  }

  const handleDecline = async (reason?: string) => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/provide-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolUseId,
          secretName,
          decline: true,
          declineReason: reason || 'User declined to provide the secret',
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to decline request')
      }

      setStatus('declined')
      onComplete()
    } catch (err: any) {
      setError(err.message || 'Failed to decline request')
      setStatus('pending')
    }
  }

  const handleFetchForMe = async () => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/provide-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolUseId,
          secretName,
          decline: true,
          declineReason: `The user wants you to fetch this secret (${secretName}) automatically. Use the browser to navigate to the appropriate website and retrieve the API key or token. If you cannot do this, explain to the user why not and request the secret again. When fetched -- make sure to save it to the .env file with the key name "${secretName}" so it's available for future sessions without needing to request it again.`,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to send request')
      }

      setStatus('fetch-requested')
      onComplete()
    } catch (err: any) {
      setError(err.message || 'Failed to send request')
      setStatus('pending')
    }
  }

  // Completed state - show minimal info
  if (status === 'provided' || status === 'declined' || status === 'fetch-requested') {
    const statusConfig = {
      provided: { icon: Key, color: 'text-green-500', labelColor: 'text-green-600', label: 'Provided' },
      declined: { icon: Key, color: 'text-red-500', labelColor: 'text-red-600', label: 'Declined' },
      'fetch-requested': { icon: Globe, color: 'text-blue-500', labelColor: 'text-blue-600', label: 'Agent fetching...' },
    } as const
    const config = statusConfig[status as keyof typeof statusConfig]

    return (
      <div className="border rounded-md bg-muted/30 shadow-md text-sm" data-testid="secret-request-completed" data-status={status}>
        <div className="flex items-center gap-2 px-3 py-2">
          <config.icon className={cn('h-4 w-4 shrink-0', config.color)} />
          <span className="font-mono text-sm">{secretName}</span>
          <span className={cn('ml-auto text-xs', config.labelColor)}>
            {config.label}
          </span>
        </div>
      </div>
    )
  }

  // Read-only state for viewers
  if (readOnly) {
    return (
      <div className="border rounded-md bg-muted/30 shadow-md text-sm">
        <div className="flex items-start gap-3 p-3">
          <div className="flex-1 min-w-0">
            <RequestTitleChip className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" icon={<Key />}>
              Secret Requested:{' '}
              <code className="bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 rounded text-amber-800 dark:text-amber-200">
                {secretName}
              </code>
            </RequestTitleChip>
            {reason && (
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1 whitespace-pre-line">{reason}</p>
            )}
          </div>
          <span className="text-xs text-amber-600 dark:text-amber-400 shrink-0">Waiting for response</span>
        </div>
      </div>
    )
  }

  // Pending/submitting state - show input form
  return (
    <div className="border rounded-md bg-muted/30 shadow-md text-sm" data-testid="secret-request" data-secret-name={secretName}>
      <div className="p-3">
        <div className="flex-1 min-w-0 space-y-3">
          {/* Header */}
          <div>
            <RequestTitleChip className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" icon={<Key />}>
              Secret Requested:{' '}
              <code className="bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 rounded text-amber-800 dark:text-amber-200">
                {secretName}
              </code>
            </RequestTitleChip>
            {reason && (
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1 whitespace-pre-line">{reason}</p>
            )}
          </div>

          {/* Input row */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showValue ? 'text' : 'password'}
                placeholder="Enter secret value..."
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={status === 'submitting'}
                className="pr-10 bg-white dark:bg-amber-950/30 border-amber-200 dark:border-amber-700 focus:border-amber-400 dark:focus:border-amber-500"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && value.trim()) {
                    handleProvide()
                  }
                }}
              />
              <button
                type="button"
                onClick={() => setShowValue(!showValue)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                disabled={status === 'submitting'}
              >
                {showValue ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>

            <Button
              onClick={handleProvide}
              disabled={!value.trim() || status === 'submitting'}
              size="sm"
              className="bg-amber-600 hover:bg-amber-700 text-white"
              data-testid="secret-provide-btn"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Provide</span>
            </Button>

            <DeclineButton
              onDecline={handleDecline}
              disabled={status === 'submitting'}
              className="border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900"
              data-testid="secret-decline-btn"
            />
          </div>

          {/* Error message */}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          {/* Info text */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-amber-600 dark:text-amber-400">
              This secret will be saved to your agent and available for future sessions.
            </p>
            <button
              type="button"
              onClick={handleFetchForMe}
              disabled={status === 'submitting'}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50 shrink-0 ml-2"
            >
              Get it for me
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
