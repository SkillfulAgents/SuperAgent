import { apiFetch } from '@renderer/lib/api'
import { useState, useRef } from 'react'
import { Globe } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import {
  BLUE_THEME,
  CompletedRequestCard,
  ReadOnlyRequestCard,
  PermissionRequestCard,
} from './permission-request-card'
import { DOMAIN_SCOPED_LEVELS, type BrowserUsePermissionLevel } from '@shared/lib/browser-use/types'

interface BrowserUseRequestItemProps {
  toolUseId: string
  method: string
  params: Record<string, unknown>
  permissionLevel: string
  domain?: string
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

const PERMISSION_LABELS: Record<string, string> = {
  browse_read: 'Read Page',
  browse_interact: 'Interact with Page',
  browse_navigate: 'Navigate',
  browse_manage: 'Browser Control',
}

export function BrowserUseRequestItem({
  toolUseId,
  method,
  params,
  permissionLevel,
  domain,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: BrowserUseRequestItemProps) {
  const [status, setStatus] = useState<'pending' | 'submitting' | 'executed' | 'denied'>('pending')
  const [error, setError] = useState<string | null>(null)
  const [editingDomain, setEditingDomain] = useState<string | null>(null)
  const domainInputRef = useRef<HTMLInputElement>(null)

  const isDomainScoped = DOMAIN_SCOPED_LEVELS.has(permissionLevel as BrowserUsePermissionLevel)

  const startEditingDomain = () => {
    setEditingDomain(domain || '')
    setTimeout(() => domainInputRef.current?.focus(), 0)
  }

  const handleApprove = async (grantType: 'once' | 'timed' | 'always') => {
    // For timed/always on domain-scoped levels, open the editor first so the user can adjust
    if (grantType !== 'once' && isDomainScoped && editingDomain === null) {
      startEditingDomain()
      return
    }

    setStatus('submitting')
    setError(null)

    const grantDomain = grantType === 'once'
      ? domain
      : (editingDomain !== null ? (editingDomain || undefined) : domain)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/browser-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            method,
            params,
            permissionLevel,
            domain: grantDomain,
            grantType,
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Request failed (${response.status})`)
      }

      setStatus('executed')
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to execute command')
      setStatus('pending')
    }
  }

  const handleDeny = async (reason?: string) => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/browser-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            decline: true,
            declineReason: reason || 'User denied browser use request',
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to deny request')
      }

      setStatus('denied')
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to deny request')
      setStatus('pending')
    }
  }

  if (status === 'executed' || status === 'denied') {
    return (
      <CompletedRequestCard
        icon={Globe}
        method={method}
        scopeLabel={domain}
        status={status}
        testIdPrefix="browser-use"
      />
    )
  }

  if (readOnly) {
    return (
      <ReadOnlyRequestCard
        icon={Globe}
        title="Browser Use Request"
        method={method}
        scopeLabel={domain}
        theme={BLUE_THEME}
      />
    )
  }

  return (
    <PermissionRequestCard
      title="Browser Use Request"
      icon={Globe}
      theme={BLUE_THEME}
      testIdPrefix="browser-use"
      permissionLabel={PERMISSION_LABELS[permissionLevel] || permissionLevel}
      scopeLabel={domain}
      method={method}
      params={params}
      warningText="This will allow the agent to use the browser. Review carefully before approving."
      status={status}
      error={error}
      onApprove={handleApprove}
      onDeny={handleDeny}
      extraContent={
        isDomainScoped && editingDomain !== null ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-blue-600 dark:text-blue-400">Domain:</span>
            <Input
              ref={domainInputRef}
              value={editingDomain}
              onChange={(e) => setEditingDomain(e.target.value)}
              placeholder="* (any domain)"
              className="h-7 text-xs max-w-[200px]"
            />
          </div>
        ) : undefined
      }
      extraActions={
        isDomainScoped && editingDomain === null ? (
          <button
            onClick={startEditingDomain}
            className="text-xs text-blue-600 dark:text-blue-400 underline hover:no-underline"
          >
            Edit domain scope for timed/always grants
          </button>
        ) : undefined
      }
    />
  )
}
