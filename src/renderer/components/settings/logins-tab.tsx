import { useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ChevronLeft, KeyRound, Trash2 } from 'lucide-react'
import { AgentAssignmentList } from '@renderer/components/agents/agent-assignment-list'
import { IntegrationList, IntegrationRow, RowHoverChevron } from '@renderer/components/connections/integration-row'
import { formatCompactDistance, safeDate } from '@renderer/components/connections/utils'
import { useFullWidthSettingsContent, useHideSettingsHeader } from '@renderer/components/settings/settings-page'
import { Button } from '@renderer/components/ui/button'
import { InlineEditableTitle } from '@renderer/components/ui/inline-editable-title'
import { SiteFavicon } from '@renderer/components/ui/site-favicon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { useUser } from '@renderer/context/user-context'
import { useAgents } from '@renderer/hooks/use-agents'
import {
  BrowserAccountRequestError,
  useBrowserAccounts,
  useDeleteBrowserAccount,
  useForgetBrowserAccountSessions,
  useGrantBrowserAccount,
  useRenameBrowserAccount,
  useRevokeBrowserAccount,
  type BrowserAccount,
} from '@renderer/hooks/use-browser-accounts'

/**
 * Settings → Logins: the user's Browser Vault. Each saved account (a site and
 * a username, with what sign-in steps saved for it), the agents that may sign
 * in with it, rename and delete. Values never reach this page.
 */

function partNames(account: Pick<BrowserAccount, 'parts'>): string[] {
  return account.parts.map((part) => (part === 'password' ? 'Password' : part.replace(/^text:/, '')))
}

/** What the account signs in with, in a few words. */
function describeAccount(account: BrowserAccount): string {
  if (account.via) return `Signs in with ${account.via.providerName} (${account.via.username})`
  const parts = partNames(account)
  const saved = parts.length ? parts.join(', ') : 'Username only'
  return account.rejectedAt ? `${saved} · rejected by the site` : saved
}

function AccountIcon({ account, className }: { account: Pick<BrowserAccount, 'origin'>; className?: string }) {
  return <SiteFavicon src={`${account.origin}/favicon.ico`} className={className ?? 'h-4 w-4'} />
}

const BROWSER_NAMES: Record<BrowserAccount['sessions'][number]['browserType'], string> = {
  container: 'Built-in browser',
  chrome: 'Chrome',
  browserbase: 'Browserbase',
  platform: 'Platform browser',
}

/** Where a signed-in session is saved, and since when: "Chrome, saved 3h ago". */
function describeSession(session: BrowserAccount['sessions'][number]): string {
  return `${BROWSER_NAMES[session.browserType]}, saved ${formatCompactDistance(safeDate(session.capturedAt))}`
}

function usedBy(count: number): string {
  return count === 0 ? 'No agent' : `${count} ${count === 1 ? 'agent' : 'agents'}`
}

export function LoginsTab() {
  const accounts = useBrowserAccounts()
  const remove = useDeleteBrowserAccount()
  const navigate = useNavigate()
  const { login: selectedId } = useSearch({ strict: false }) as { login?: string }
  const [deleting, setDeleting] = useState<BrowserAccount | null>(null)
  const list = accounts.data ?? []
  const selected = selectedId ? list.find((account) => account.id === selectedId) : undefined

  const open = (id: string | undefined) => {
    void navigate({ to: '/settings/$tab', params: { tab: 'logins' }, search: (prev) => ({ ...prev, login: id }) })
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync(deleting.id)
      if (selectedId === deleting.id) open(undefined)
      toast.success(`Deleted ${deleting.label || deleting.username} on ${deleting.site}`)
    } catch (error) {
      toast.error('Could not delete the login', { description: error instanceof Error ? error.message : 'Please try again.' })
    } finally {
      setDeleting(null)
    }
  }

  const deleteDialog = (
    <AlertDialog open={deleting !== null} onOpenChange={(isOpen) => { if (!isOpen) setDeleting(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {deleting?.label || deleting?.username} on {deleting?.site}?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting && deleting.agentSlugs.length > 0
              ? `${usedBy(deleting.agentSlugs.length)} can no longer sign in with it; they ask you instead. `
              : ''}
            Browsers already signed in stay signed in. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirmDelete()} data-testid="login-delete-confirm">Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  if (selectedId) {
    return (
      <>
        {selected ? (
          <LoginDetailPage account={selected} onBack={() => open(undefined)} onDelete={() => setDeleting(selected)} />
        ) : (
          <div className="space-y-3">
            <Button variant="ghost" size="sm" onClick={() => open(undefined)}>Back to logins</Button>
            <p role={accounts.isLoading ? 'status' : 'alert'} className="text-sm text-muted-foreground">
              {accounts.isLoading ? 'Loading login…' : accounts.error ? 'Could not load this login. Please try again.' : 'This login is no longer saved.'}
            </p>
          </div>
        )}
        {deleteDialog}
      </>
    )
  }

  return (
    <div className="space-y-6" data-testid="logins-settings">
      <p className="text-sm text-muted-foreground">
        Accounts you saved when an agent asked you to sign in. Agents you allow sign in with them without asking you; passwords never reach the agent.
      </p>
      {accounts.error && <p role="alert" className="text-sm text-destructive">Could not load saved logins. Please try again.</p>}
      {accounts.isLoading ? (
        <p className="text-sm text-muted-foreground" role="status">Loading saved logins…</p>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-background px-6 py-10 text-center" data-testid="logins-empty">
          <KeyRound className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
          <p className="text-sm font-medium">No saved logins yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            When an agent asks you to sign in, keep &quot;Save for later&quot; checked and the account lands here.
          </p>
        </div>
      ) : (
        <IntegrationList>
          {list.map((account) => (
            <IntegrationRow
              key={account.id}
              data-testid={`login-row-${account.id}`}
              icon={<AccountIcon account={account} />}
              name={account.label || account.username}
              subtitle={<>
                <span className="min-w-0 truncate">{account.site}</span>
                {account.label && <><span className="shrink-0">·</span><span className="min-w-0 truncate">{account.username}</span></>}
                <span className="shrink-0">·</span>
                <span className="min-w-0 truncate">{describeAccount(account)}</span>
                <span className="shrink-0">·</span>
                <span className="shrink-0 whitespace-nowrap" data-testid={`login-row-agents-${account.id}`}>{usedBy(account.agentSlugs.length)}</span>
              </>}
              onActivate={() => open(account.id)}
              ariaLabel={`Open ${account.username} on ${account.site}`}
              right={<>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${account.username} on ${account.site}`}
                  onClick={(event) => { event.stopPropagation(); setDeleting(account) }}
                  data-testid={`login-row-delete-${account.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <RowHoverChevron />
              </>}
            />
          ))}
        </IntegrationList>
      )}
      {deleteDialog}
    </div>
  )
}

/** Resolves when the user answers the shared-agent question: true to share. */
type SharedConfirm = { agentName: string; resolve: (share: boolean) => void }

function LoginDetailPage({ account, onBack, onDelete }: { account: BrowserAccount; onBack: () => void; onDelete: () => void }) {
  useHideSettingsHeader(true)
  useFullWidthSettingsContent(true)
  const { isAuthMode, rolesReady, canUseAgent } = useUser()
  const agents = useAgents()
  const grant = useGrantBrowserAccount()
  const revoke = useRevokeBrowserAccount()
  const rename = useRenameBrowserAccount()
  const forgetSessions = useForgetBrowserAccountSessions()
  const [confirming, setConfirming] = useState<SharedConfirm | null>(null)
  const confirmingRef = useRef<SharedConfirm | null>(null)
  confirmingRef.current = confirming

  const askToShare = (agentName: string) => new Promise<boolean>((resolve) => setConfirming({ agentName, resolve }))
  const answer = (share: boolean) => {
    confirmingRef.current?.resolve(share)
    setConfirming(null)
  }

  const onToggle = async (agentSlug: string, next: boolean) => {
    if (!next) {
      await revoke.mutateAsync({ agentSlug, accountId: account.id })
      return
    }
    try {
      await grant.mutateAsync({ agentSlug, accountId: account.id })
    } catch (error) {
      // Other people use this agent (members, admins): they could have it sign in as this account.
      if (!(error instanceof BrowserAccountRequestError) || error.reason !== 'shared_agent') throw error
      const agentName = agents.data?.find((agent) => agent.slug === agentSlug)?.name ?? agentSlug
      if (!(await askToShare(agentName))) throw new Error(`${account.username} was not shared with ${agentName}.`)
      await grant.mutateAsync({ agentSlug, accountId: account.id, sharedAgentAcknowledged: true })
    }
  }

  // The agents the user can grant to (the routes ask for the 'user' role),
  // and every agent granted already, even one the user can no longer open:
  // the owner can always turn a grant off.
  const usable = (agents.data ?? []).filter((agent) => !isAuthMode || (rolesReady && canUseAgent(agent.slug)))
  const listed = [
    ...usable,
    ...account.agents
      .filter((granted) => !usable.some((agent) => agent.slug === granted.slug))
      .map((granted) => ({ slug: granted.slug, name: granted.name, displaySlug: granted.slug })),
  ]
  const parts = partNames(account)
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4" data-testid="login-detail">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground" data-testid="login-detail-back">
          <ChevronLeft className="mr-1 h-3.5 w-3.5" />
          Logins
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
          <AccountIcon account={account} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <InlineEditableTitle
            value={account.label || account.username}
            canEdit
            isSaving={rename.isPending}
            onSave={async (value) => {
              const label = value.trim()
              await rename.mutateAsync({ accountId: account.id, label: label && label !== account.username ? label : null })
            }}
            onError={(error) => toast.error('Could not rename the login', { description: error instanceof Error ? error.message : undefined })}
            displayClassName="text-base font-medium"
            ariaLabel="Login name"
            displayTestId="login-detail-name"
          />
          <p className="truncate text-xs text-muted-foreground">
            {account.label ? `${account.username} · ` : ''}{account.site}
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 text-destructive hover:text-destructive" onClick={onDelete} data-testid="login-detail-delete">
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          Delete
        </Button>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 pt-4 xl:grid-cols-[1fr_24rem]">
        <section className="min-w-0" aria-label="Agents that can sign in with this login">
          <AgentAssignmentList
            agents={listed}
            assignedSlugs={account.agentSlugs}
            isLoading={agents.isLoading || (isAuthMode && !rolesReady)}
            error={agents.error}
            sectioned
            assignedLabel="Agents That Can Sign In"
            unassignedLabel="Agents That Ask You"
            emptyAssigned="No agent can sign in with this login. Turn one on below."
            onToggle={onToggle}
            toggleLabel={(agent, assigned) => `${assigned ? 'Stop' : 'Let'} ${agent.name} ${assigned ? 'signing' : 'sign'} in as ${account.username} on ${account.site}`}
            testId={(slug) => `login-agent-toggle-${account.id}-${slug}`}
          />
        </section>

        <section className="min-w-0 space-y-2" aria-label="What is saved">
          <h3 className="text-xs font-normal text-muted-foreground">Saved</h3>
          <div className="divide-y divide-border/50 overflow-hidden rounded-xl border bg-background text-xs" data-testid="login-detail-saved">
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-24 shrink-0 text-muted-foreground">Username</span>
              <span className="min-w-0 break-all">{account.username}</span>
            </div>
            {account.via && (
              <div className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-24 shrink-0 text-muted-foreground">Signs in with</span>
                <span className="min-w-0 break-all">{account.via.providerName}: {account.via.username}</span>
              </div>
            )}
            {parts.map((part) => (
              <div key={part} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-24 shrink-0 truncate text-muted-foreground">{part}</span>
                <span className="tracking-widest text-muted-foreground" aria-label="Saved, hidden">••••••••</span>
              </div>
            ))}
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-24 shrink-0 text-muted-foreground">Saved on</span>
              <span className="min-w-0 break-all">{account.origin}</span>
            </div>
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-24 shrink-0 text-muted-foreground">Last used</span>
              <span>{account.lastUsedAt ? formatCompactDistance(safeDate(account.lastUsedAt)) : 'Never'}</span>
            </div>
            {account.sessions.length > 0 && (
              <div className="flex items-center gap-3 px-4 py-2.5" data-testid="login-session">
                <span className="w-24 shrink-0 text-muted-foreground">Session</span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  {account.sessions.map((session) => <span key={session.browserType} className="block">{describeSession(session)}</span>)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-my-1 h-6 shrink-0 px-2 text-2xs"
                  disabled={forgetSessions.isPending}
                  onClick={() => {
                    forgetSessions.mutateAsync(account.id)
                      .then(() => toast.success('Forgot the saved session', { description: 'The next sign-in with this login fills its values.' }))
                      .catch((error: unknown) => toast.error('Could not forget the session', { description: error instanceof Error ? error.message : 'Please try again.' }))
                  }}
                  data-testid="login-session-forget"
                >
                  Forget
                </Button>
              </div>
            )}
            {account.rejectedAt && (
              <div className="flex items-start gap-3 px-4 py-2.5" data-testid="login-rejected">
                <span className="w-24 shrink-0 text-muted-foreground">Rejected</span>
                <span className="min-w-0 text-amber-700 dark:text-amber-400">
                  An agent said the site rejected its password, {formatCompactDistance(safeDate(account.rejectedAt))}. Agents ask you to sign in until you enter it again.
                </span>
              </div>
            )}
          </div>
          <p className="px-1 text-2xs text-muted-foreground">
            Saved values are never shown. An agent signs in with them; when the site rejects one, it asks you again and what you enter replaces it.
            {account.sessions.length > 0 && ' A saved session signs an agent in without them, in the same kind of browser it was saved in.'}
          </p>
        </section>
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(isOpen) => { if (!isOpen) answer(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Share {account.username} with {confirming?.agentName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Other people can use {confirming?.agentName}: its members and the workspace admins. They will be able to have it sign in to {account.site} as you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => answer(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => answer(true)} data-testid="login-share-confirm">Share</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
