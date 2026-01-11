'use client'

import { useState } from 'react'
import { Key, Eye, EyeOff, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils/cn'

interface SecretRequestItemProps {
  toolUseId: string
  secretName: string
  reason?: string
  sessionId: string
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'provided' | 'declined'

export function SecretRequestItem({
  toolUseId,
  secretName,
  reason,
  sessionId,
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
      const response = await fetch(`/api/sessions/${sessionId}/provide-secret`, {
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

  const handleDecline = async () => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await fetch(`/api/sessions/${sessionId}/provide-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolUseId,
          secretName,
          decline: true,
          declineReason: 'User declined to provide the secret',
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

  // Completed state - show minimal info
  if (status === 'provided' || status === 'declined') {
    return (
      <div className="border rounded-md bg-muted/30 text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <Key
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'provided' ? 'text-green-500' : 'text-red-500'
            )}
          />
          <span className="font-mono text-sm">{secretName}</span>
          <span
            className={cn(
              'ml-auto text-xs',
              status === 'provided' ? 'text-green-600' : 'text-red-600'
            )}
          >
            {status === 'provided' ? 'Provided' : 'Declined'}
          </span>
        </div>
      </div>
    )
  }

  // Pending/submitting state - show input form
  return (
    <div className="border rounded-md bg-amber-50 border-amber-200 text-sm">
      <div className="flex items-start gap-3 p-3">
        {/* Icon */}
        <div className="h-8 w-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
          <Key className="h-4 w-4 text-amber-600" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-3">
          {/* Header */}
          <div>
            <div className="font-medium text-amber-900">
              Secret Requested:{' '}
              <code className="bg-amber-100 px-1.5 py-0.5 rounded text-amber-800">
                {secretName}
              </code>
            </div>
            {reason && (
              <p className="text-sm text-amber-700 mt-1">{reason}</p>
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
                className="pr-10 bg-white border-amber-200 focus:border-amber-400"
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
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Provide</span>
            </Button>

            <Button
              onClick={handleDecline}
              disabled={status === 'submitting'}
              variant="outline"
              size="sm"
              className="border-amber-200 text-amber-700 hover:bg-amber-100"
            >
              <X className="h-4 w-4" />
              <span className="ml-1">Decline</span>
            </Button>
          </div>

          {/* Error message */}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          {/* Info text */}
          <p className="text-xs text-amber-600">
            This secret will be saved to your agent and available for future sessions.
          </p>
        </div>
      </div>
    </div>
  )
}
