import { ScriptRunRequestItem } from '@renderer/components/messages/script-run-request-item'
import { AccountReauthRequestItem } from '@renderer/components/messages/account-reauth-request-item'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import type { TodoCard } from './todo-schema'
import { todoActions } from './todo-store'

const GRANT_LABEL = { once: 'Allowed once', timed: 'Allowed for 15 min', always: 'Always allowed' } as const

/**
 * The session's own approval card for a one-click request on a task, wired
 * to the board instead of a session. Same component, same copy, same
 * buttons — the user sees exactly what they would see in the session.
 */
export function TodoRequestCard({ card, onResolved }: { card: TodoCard; onResolved?: () => void }) {
  const request = card.request
  if (!request) return null
  return <RequestBody card={card} request={request} onResolved={onResolved} />
}

function RequestBody({ card, request, onResolved }: { card: TodoCard; request: NonNullable<TodoCard['request']>; onResolved?: () => void }) {
  const agent = card.agents[0]
  const resolve = (outcome: string) => {
    todoActions.resolveRequest(card.id, outcome)
    onResolved?.()
  }

  if (request.type === 'script_run') {
    return (
      <ScriptRunRequestItem
        toolUseId={card.id}
        script={request.script}
        explanation={request.explanation}
        scriptType={request.scriptType}
        onDecide={(d) => resolve(d.approved ? `${GRANT_LABEL[d.grantType]}: ${request.explanation}` : `Denied: ${d.reason}`)}
        onComplete={() => {}}
      />
    )
  }

  const provider = getProvider(request.toolkit)?.displayName ?? request.toolkit
  return (
    <AccountReauthRequestItem
      proxyRequestId={card.id}
      accountId={`todo-${request.toolkit}`}
      toolkit={request.toolkit}
      accountStatus={request.accountStatus}
      agentSlug={agent?.slug ?? 'new-agent'}
      onReconnect={() => {
        resolve(`Reconnected ${provider}`)
        return true
      }}
      onDismiss={(reason) => resolve(`Dismissed the ${provider} reconnect${reason ? `: ${reason}` : ''}`)}
      onComplete={() => {}}
    />
  )
}
