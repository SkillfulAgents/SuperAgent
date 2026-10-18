import { Users, Vault } from 'lucide-react'
import type { SavedLogins } from '@renderer/hooks/use-saved-logins'

/** Shown before applying a saved login to an agent other members can use. */
export function sharedLoginNotice(otherMembers: number, site: string): string {
  return `${otherMembers} other ${otherMembers === 1 ? 'member' : 'members'} can use this agent. It will stay signed in to ${site} with your account. The saved login may also include other sites you signed in to along the way.`
}

interface SavedLoginPickerProps {
  savedLogins: SavedLogins
  disabled?: boolean
  /** Other members of the agent; when any, the picker says they can use the applied login. Null while unknown. */
  otherMembers: number | null
}

export function SavedLoginPicker({ savedLogins, disabled, otherMembers }: SavedLoginPickerProps) {
  const { logins, applyingId, applied, settled, error, apply } = savedLogins
  if (!logins || logins.length === 0) return null

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3" data-testid="saved-login-picker">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <Vault className="h-3.5 w-3.5" />
        Use a saved login
      </div>
      {!applied && otherMembers !== null && otherMembers > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="saved-login-shared-notice">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {sharedLoginNotice(otherMembers, logins[0].site)}
        </p>
      )}
      {applied ? (
        settled && <p className="mt-2 text-xs text-muted-foreground">Saved login applied. The agent will check that it is signed in.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {logins.map((login) => (
            <button
              key={login.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-md border border-border bg-background px-2.5 py-2 text-left hover:bg-muted disabled:opacity-50"
              onClick={() => apply(login.id, otherMembers !== 0)}
              // Until the member count is known, applying could skip the shared-agent notice.
              disabled={disabled || applyingId !== null || otherMembers === null}
              data-testid={`saved-login-${login.id}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{login.name}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  Saved {new Date(login.capturedAt).toLocaleString()}
                </span>
              </span>
              <span className="text-2xs font-medium text-blue-600 dark:text-blue-400">
                {applyingId === login.id ? 'Applying…' : 'Use'}
              </span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}
