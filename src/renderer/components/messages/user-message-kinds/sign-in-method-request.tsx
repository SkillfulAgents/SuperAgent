import { KeyRound } from 'lucide-react'
import { parseSignInMethodRequestMessage } from '@shared/lib/utils/sign-in-method-request'
import type { UserMessageKindSpec, UserMessageRenderProps } from './types'

/**
 * The user's request for an authenticator app, made in the sign-in
 * card or Settings → Logins: the agent reads it as their message, and the
 * transcript draws it as what they did there, not as something they typed.
 */
export function SignInMethodRequestNotice({ text, message }: UserMessageRenderProps) {
  const request = parseSignInMethodRequestMessage(text)
  if (!request) return null
  return (
    <div
      className="my-6 rounded-card border border-border bg-muted/30 px-4 py-3 text-sm"
      data-testid="sign-in-method-request-notice"
      data-turn-anchor-id={message.id}
    >
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {`Asked ${request.again ? 'again ' : ''}from ${request.from === 'card' ? 'the sign-in form' : 'Settings → Logins'}`}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground break-words">
            Add an authenticator app to {request.username} on {request.site}. The agent was told to add one once it is signed in.
          </p>
        </div>
      </div>
    </div>
  )
}

export const signInMethodRequestNotice: UserMessageKindSpec = {
  kind: 'sign-in-method-request',
  match: (text) => parseSignInMethodRequestMessage(text) !== null,
  hidden: false,
  Render: SignInMethodRequestNotice,
  chrome: 'row',
  foldsIntoWork: true,
}
