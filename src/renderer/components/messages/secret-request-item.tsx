import { apiFetch } from '@renderer/lib/api'

import { useState } from 'react'
import { Key, Eye, EyeOff, Globe, ArrowUpRight } from 'lucide-react'
import { useRequestHandler } from '@renderer/hooks/use-request-handler'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DeclineButton } from './decline-button'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'
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

function formatSecretReason(secretName: string, reason: string): string {
  const trimmedReason = reason.trim()
  if (!trimmedReason) {
    return `Provide ${secretName}`
  }

  const normalizedReason =
    trimmedReason[0] === trimmedReason[0]?.toUpperCase()
      ? trimmedReason[0].toLowerCase() + trimmedReason.slice(1)
      : trimmedReason

  return `Provide ${secretName} ${normalizedReason}`
}

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
  const { status, error, submit } = useRequestHandler(onComplete)

  const postSecret = async (body: Record<string, unknown>) => {
    const response = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/provide-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId, secretName, ...body }),
    })
    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error || 'Request failed')
    }
  }

  const handleProvide = () => {
    if (!value.trim()) return
    submit(() => postSecret({ value: value.trim() }), 'provided')
  }

  const handleDecline = (reason?: string) => {
    submit(
      () => postSecret({ decline: true, declineReason: reason || 'User declined to provide the secret' }),
      'declined',
    )
  }

  const handleFetchForMe = () => {
    submit(
      () => postSecret({
        decline: true,
        declineReason: `The user wants you to fetch this secret (${secretName}) automatically. Use the browser to navigate to the appropriate website and retrieve the API key or token. If you cannot do this, explain to the user why not and request the secret again. When fetched -- make sure to save it to the .env file with the key name "${secretName}" so it's available for future sessions without needing to request it again.`,
      }),
      'fetch-requested',
    )
  }

  // Build completed config for the 3 outcome states
  const isCompleted = status === 'provided' || status === 'declined' || status === 'fetch-requested'
  const completedConfig = isCompleted
    ? (() => {
        if (status === 'fetch-requested') {
          return {
            icon: <Globe className={cn('h-4 w-4 shrink-0', 'text-blue-500')} />,
            label: <span className="font-mono text-sm">{secretName}</span>,
            statusLabel: 'Agent fetching...',
            isSuccess: true,
          }
        }
        return {
          icon: (
            <Key
              className={cn(
                'h-4 w-4 shrink-0',
                status === 'provided' ? 'text-green-500' : 'text-red-500'
              )}
            />
          ),
          label: <span className="font-mono text-sm">{secretName}</span>,
          statusLabel: status === 'provided' ? 'Provided' : 'Declined',
          isSuccess: status === 'provided',
        }
      })()
    : null

  // Build read-only config
  const readOnlyConfig = readOnly
    ? {
        description: reason ? (
          <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">
            {formatSecretReason(secretName, reason)}
          </p>
        ) : undefined,
        extraContent: (
          <code className="mt-6 inline-flex h-7 items-center rounded-md bg-muted px-2.5 font-mono text-xs font-medium text-foreground/80">
            {secretName}
          </code>
        ),
      }
    : false as const

  return (
    <RequestItemShell
      title="Secret Request"
      icon={<Key />}
      theme="orange"
      completed={completedConfig}
      readOnly={readOnlyConfig}
      waitingText="Waiting for response"
      error={error}
      data-testid={isCompleted ? 'secret-request-completed' : 'secret-request'}
      data-status={isCompleted ? status : undefined}
      data-secret-name={!isCompleted && !readOnly ? secretName : undefined}
    >
      {/* Description */}
      {reason && (
        <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">
          {formatSecretReason(secretName, reason)}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Your secret will be stored securely and available for future sessions.
      </p>

      {/* Input */}
      <div className="pt-3">
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <div className="relative">
            <Input
              type={showValue ? 'text' : 'password'}
              autoFocus
              placeholder={`Paste ${secretName}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={status === 'submitting'}
              className="pr-10 bg-white border-border"
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
          </div>
        </div>
      </div>

      {/* Action row */}
      <RequestItemActions className="items-center justify-between">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={handleFetchForMe}
                disabled={status === 'submitting'}
                variant="outline"
                size="sm"
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <span>Fetch secret for me</span>
                <ArrowUpRight className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[240px]">
              Not sure where to find your secret? Your agent can use your browser to go fetch it for you.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="flex justify-end gap-2">
          <DeclineButton
            onDecline={handleDecline}
            disabled={status === 'submitting'}
            showIcon={false}
            className="border-border text-foreground hover:bg-muted"
            data-testid="secret-decline-btn"
          />

          <Button
            onClick={handleProvide}
            loading={status === 'submitting'}
            disabled={!value.trim()}
            size="sm"
            className="min-w-24 bg-orange-600 hover:bg-orange-700 text-white"
            data-testid="secret-provide-btn"
          >
            Save
          </Button>
        </div>
      </RequestItemActions>
    </RequestItemShell>
  )
}
