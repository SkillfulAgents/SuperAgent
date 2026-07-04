import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  useApproveChatAccess,
  useDenyChatAccess,
  useRevokeChatAccess,
} from '@renderer/hooks/use-chat-integrations'
import type { ChatRow } from './chat-inbox-model'

/** One access action with a per-button spinner while its own mutation is in flight.
 *  `disabled` defaults to `pending` but can be widened so sibling actions lock out
 *  together (a pending chat's Approve/Deny must not both fire). stopPropagation so a
 *  click inside a clickable inbox row doesn't also open it. */
function AccessButton({ label, pending, disabled, onClick, className, variant = 'ghost' }: {
  label: string
  pending: boolean
  disabled?: boolean
  onClick: () => void
  className?: string
  variant?: 'ghost' | 'outline'
}) {
  return (
    <Button
      size="xs"
      variant={variant}
      className={className}
      disabled={disabled ?? pending}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : label}
    </Button>
  )
}

/**
 * The access-decision buttons for one chat, keyed to its status - shared by the
 * inbox row (hover-revealed) and the request modal (always shown). A pending chat
 * offers both Approve and Deny; a decided chat offers the single reversing action
 * (Unblock a denial, Block an allowed chat). Renders nothing without an access row.
 * `onActed` fires after a successful decision so the modal can close back to the list.
 */
export function AccessActions({ row, integrationId, onActed }: {
  row: ChatRow
  integrationId: string
  onActed?: () => void
}) {
  const approve = useApproveChatAccess()
  const deny = useDenyChatAccess()
  const revoke = useRevokeChatAccess()

  const accessId = row.accessId
  if (!accessId) return null

  if (row.status === 'pending') {
    // Both decisions target the same access row, so once one is in flight, lock the
    // other out - otherwise a fast Approve-then-Deny races two conflicting writes.
    const deciding = approve.isPending || deny.isPending
    return (
      <>
        <AccessButton
          label="Approve"
          variant="outline"
          pending={approve.isPending}
          disabled={deciding}
          onClick={() => approve.mutate({ integrationId, accessId }, { onSuccess: onActed })}
        />
        <AccessButton
          label="Deny"
          className="text-muted-foreground hover:text-destructive"
          pending={deny.isPending}
          disabled={deciding}
          onClick={() => deny.mutate({ integrationId, accessId }, { onSuccess: onActed })}
        />
      </>
    )
  }
  if (row.status === 'denied') {
    return (
      <AccessButton
        label="Unblock"
        pending={approve.isPending}
        onClick={() => approve.mutate({ integrationId, accessId }, { onSuccess: onActed })}
      />
    )
  }
  if (row.status === 'allowed') {
    return (
      <AccessButton
        label="Block"
        className="text-muted-foreground hover:text-destructive"
        pending={revoke.isPending}
        onClick={() => revoke.mutate({ integrationId, accessId }, { onSuccess: onActed })}
      />
    )
  }
  return null
}
