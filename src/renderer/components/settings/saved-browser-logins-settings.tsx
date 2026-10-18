import { useCallback, useEffect, useState } from 'react'
import { Globe, Loader2, MoreHorizontal, Pencil, Trash2, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
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

interface SavedBrowserLogin {
  id: string
  name: string
  site: string
  browserType: 'container' | 'chrome' | 'browserbase' | 'platform'
  version: number
  capturedAt: string
  agents: Array<{ slug: string; name: string }>
}

const BROWSER_TYPE_LABELS: Record<SavedBrowserLogin['browserType'], string> = {
  container: 'Container browser',
  chrome: 'Chrome',
  browserbase: 'Browserbase',
  platform: 'Platform browser',
}

function formatSavedAt(value: string): string {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const MENU_ITEM_CLASS = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50'

function SavedLoginRowMenu({
  login,
  disabled,
  onRename,
  onUnmap,
  onDelete,
}: {
  login: SavedBrowserLogin
  disabled: boolean
  onRename: () => void
  onUnmap: (agentSlug: string) => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const choose = (action: () => void) => () => {
    setOpen(false)
    action()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          disabled={disabled}
          aria-label={`Actions for ${login.name}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1">
        <button type="button" className={MENU_ITEM_CLASS} onClick={choose(onRename)}>
          <Pencil className="h-4 w-4" />
          Rename
        </button>
        {login.agents.map((agent) => (
          <button key={agent.slug} type="button" className={MENU_ITEM_CLASS} onClick={choose(() => onUnmap(agent.slug))}>
            <Unlink className="h-4 w-4 shrink-0" />
            <span className="truncate">Stop using in {agent.name}</span>
          </button>
        ))}
        <button type="button" className={`${MENU_ITEM_CLASS} text-destructive`} onClick={choose(onDelete)}>
          <Trash2 className="h-4 w-4" />
          Delete
        </button>
      </PopoverContent>
    </Popover>
  )
}

function reportNotCleared(notCleared: unknown, agents: SavedBrowserLogin['agents']): void {
  if (!Array.isArray(notCleared) || notCleared.length === 0) return
  const names = notCleared.map((slug) => agents.find((agent) => agent.slug === slug)?.name ?? String(slug))
  toast.warning(`Could not clear the browser for ${names.join(', ')}; that agent may still be signed in until you sign out there.`)
}

export function SavedBrowserLoginsSettings() {
  const [logins, setLogins] = useState<SavedBrowserLogin[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SavedBrowserLogin | null>(null)
  const [workingId, setWorkingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/browser-logins')
      const result = await response.json() as { logins?: SavedBrowserLogin[]; error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not load saved logins')
      setLogins(result.logins ?? [])
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load saved logins')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (id: string, request: () => Promise<Response>, onSuccess?: (result: Record<string, unknown>) => void) => {
    setWorkingId(id)
    try {
      const response = await request()
      const result = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Request failed')
      onSuccess?.(result)
      await load()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Request failed')
    } finally {
      setWorkingId(null)
    }
  }

  const saveName = (id: string, name: string) => run(id, () => apiFetch(`/api/browser-logins/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }), () => setRenaming(null))

  const remove = (login: SavedBrowserLogin) => run(login.id, () => apiFetch(
    `/api/browser-logins/${encodeURIComponent(login.id)}`,
    { method: 'DELETE' },
  ), (result) => reportNotCleared(result.notCleared, login.agents))

  const unmap = (login: SavedBrowserLogin, agentSlug: string) => run(login.id, () => apiFetch(
    `/api/browser-logins/${encodeURIComponent(login.id)}/agents/${encodeURIComponent(agentSlug)}`,
    { method: 'DELETE' },
  ), (result) => reportNotCleared(result.notCleared, login.agents))

  return (
    <div id="saved-browser-logins" className="space-y-2" data-testid="saved-browser-logins">
      <h3 className="px-1 text-xs font-medium text-muted-foreground">Saved Logins</h3>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading saved logins...
        </div>
      ) : error && logins.length === 0 ? null : logins.length === 0 ? (
        <div className="rounded-xl border bg-background px-4 py-3 text-xs text-muted-foreground">
          No saved logins yet. When an agent asks you to sign in, keep &quot;Save login to my vault&quot; checked to save it here.
        </div>
      ) : (
        <div className="rounded-xl border bg-background divide-y divide-border/50 overflow-hidden">
          {logins.map((login) => {
            const busy = workingId === login.id
            const editing = renaming?.id === login.id
            return (
              <div key={login.id} className="flex items-center gap-3 px-4 py-3" data-testid={`saved-browser-login-${login.id}`}>
                <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  {editing ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        if (renaming.name.trim()) void saveName(login.id, renaming.name.trim())
                      }}
                    >
                      <Input
                        autoFocus
                        value={renaming.name}
                        onChange={(event) => setRenaming({ id: login.id, name: event.target.value })}
                        className="h-7 max-w-64 text-xs"
                        aria-label="Login name"
                      />
                      <Button type="submit" size="xs" disabled={busy || !renaming.name.trim()}>Save</Button>
                      <Button type="button" size="xs" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <div className="truncate text-xs font-medium">
                      {login.name}
                      {login.name !== login.site && <span className="ml-1.5 font-normal text-muted-foreground">{login.site}</span>}
                    </div>
                  )}
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {BROWSER_TYPE_LABELS[login.browserType]} · Saved {formatSavedAt(login.capturedAt)}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {login.agents.length === 0
                      ? 'Not used by any agent'
                      : `Used by ${login.agents.map((agent) => agent.name).join(', ')}`}
                  </div>
                </div>
                {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
                {!editing && (
                  <SavedLoginRowMenu
                    login={login}
                    disabled={busy}
                    onRename={() => setRenaming({ id: login.id, name: login.name })}
                    onUnmap={(agentSlug) => void unmap(login, agentSlug)}
                    onDelete={() => setPendingDelete(login)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
      {error && <p className="px-1 text-xs text-destructive">{error}</p>}

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents using this login are signed out of {pendingDelete?.site} if their browser is open. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) void remove(pendingDelete)
                setPendingDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
