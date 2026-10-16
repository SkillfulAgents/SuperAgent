import { toast } from 'sonner'
import { Settings2 } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { ScopePolicyEditorBody, scopeGroupTitle, type ScopePolicyFilters } from '@renderer/components/settings/scope-policy-editor'

// Outside filter state with no controls keeps the editor's search bar out of the menu.
const NO_FILTERS: ScopePolicyFilters = {
  textFilter: '',
  setTextFilter: () => {},
  decisionFilter: 'all',
  setDecisionFilter: () => {},
}

/** Opens the connection's page, where its permissions and rules live. */
export function OpenSettingsButton({ toolkit, onClick, size = 'sm', className }: { toolkit: string; onClick: () => void; size?: 'sm' | 'xs'; className?: string }) {
  return (
    <Button
      variant="ghost"
      size={size}
      data-testid="proxy-review-edit-permissions"
      onClick={onClick}
      className={cn('gap-1.5', className)}
    >
      <Settings2 className="h-3.5 w-3.5 shrink-0" />
      <span>
        Open <span className="capitalize">{toolkit}</span> settings
      </span>
    </Button>
  )
}

interface PermissionsMenuProps {
  accountId: string
  toolkit: string
  accountName: string
  /** Scopes the request matched; any one of them lets it through. */
  requestScopes: string[]
  submitting: boolean
  /** Holds the card's other decisions off while Save & Allow saves first. */
  onSubmittingChange: (submitting: boolean) => void
  onOpenSettings: () => void
  onSaved: () => void
  onAllow: () => void
}

/** The account's permissions editor, with a footer that saves rules and answers the review. */
export function PermissionsMenu({
  accountId,
  toolkit,
  accountName,
  requestScopes,
  submitting,
  onSubmittingChange,
  onOpenSettings,
  onSaved,
  onAllow,
}: PermissionsMenuProps) {
  return (
    <div className="w-full space-y-2 p-1">
      <h3 className="truncate px-1 text-xs font-normal text-muted-foreground">
        <span className="capitalize">{toolkit}</span> permissions
        <span className="text-muted-foreground/70"> · {accountName}</span>
      </h3>
      {requestScopes.length > 0 && (
        <p data-testid="proxy-review-request-scopes" className="px-1 text-xs text-muted-foreground">
          This request needs{requestScopes.length > 1 ? ' any of' : ''}{' '}
          {requestScopes.map((scope, i) => (
            <span key={scope}>
              {i > 0 && ', '}
              <code className="font-mono text-foreground/85">{scope}</code> ({scopeGroupTitle(toolkit, scope)})
            </span>
          ))}
        </p>
      )}
      <div className="rounded-xl border bg-background py-2">
        <ScopePolicyEditorBody
          accountId={accountId}
          toolkit={toolkit}
          filters={NO_FILTERS}
          requestScopes={requestScopes}
          renderActions={({ isDirty, saving, save }) => (
            <>
              <OpenSettingsButton toolkit={toolkit} onClick={onOpenSettings} className="mr-auto text-muted-foreground hover:text-foreground" />
              {isDirty && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="proxy-review-save-permissions"
                  disabled={saving}
                  onClick={async () => {
                    if (await save()) onSaved()
                    else toast.error('Failed to save permissions')
                  }}
                >
                  Save
                </Button>
              )}
              <Button
                size="sm"
                data-testid="proxy-review-allow-once-menu-btn"
                disabled={saving || submitting}
                onClick={async () => {
                  if (isDirty) {
                    // Hold Deny off until the save settles, so one decision goes out.
                    onSubmittingChange(true)
                    if (!(await save())) {
                      onSubmittingChange(false)
                      toast.error('Failed to save permissions')
                      return
                    }
                  }
                  onAllow()
                }}
                className="bg-orange-600 text-white hover:bg-orange-700"
              >
                {isDirty ? 'Save & Allow' : 'Allow Once'}
              </Button>
            </>
          )}
        />
      </div>
    </div>
  )
}
