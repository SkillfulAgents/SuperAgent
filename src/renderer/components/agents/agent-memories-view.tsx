import { useState } from 'react'
import { useBlocker, useNavigate } from '@tanstack/react-router'
import { Brain, ChevronRight, FileText, Loader2, Pencil, RefreshCw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@renderer/components/ui/alert-dialog'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useUser } from '@renderer/context/user-context'
import { useAgentMemories, useAgentMemory, useSaveAgentMemory, MemoryRequestError } from '@renderer/hooks/use-agent-memories'
import type { AgentMemoryEntry } from '@shared/lib/types/memory'

export function AgentMemoriesView({ agentSlug }: { agentSlug: string }) {
  const navigate = useNavigate()
  const { isAuthMode, rolesReady, canAdminAgent } = useUser()
  const canManage = !isAuthMode || (rolesReady && canAdminAgent(agentSlug))
  const memories = useAgentMemories(canManage ? agentSlug : null)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const entries = memories.data ?? []
  const filtered = entries.filter(entry =>
    `${entry.title} ${entry.description} ${entry.path} ${entry.type ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  )

  if (canManage && selected !== null) {
    return <MemoryDetail key={selected} agentSlug={agentSlug} path={selected} entries={entries} onBack={() => setSelected(null)} onSelect={setSelected} />
  }

  return (
    <SettingsPageContainer>
      <PageTitle title="Memories" back={{
        label: 'Agent home',
        onClick: () => { void navigate({ to: '/agents/$slug', params: { slug: agentSlug } }) },
      }} actions={canManage && (
        <Button variant="outline" size="sm" onClick={() => void memories.refetch()} disabled={memories.isFetching}>
          <RefreshCw className="mr-2 h-4 w-4" />Refresh
        </Button>
      )} />
      {!canManage ? (
        <p className="text-sm text-muted-foreground">{isAuthMode && !rolesReady ? 'Loading permissions…' : 'Only agent admins can view and edit memories.'}</p>
      ) : memories.isLoading ? (
        <Loading />
      ) : memories.isError ? (
        <ErrorMessage message={memories.error.message} retry={() => void memories.refetch()} />
      ) : entries.length === 0 ? (
        <div className="rounded-xl border px-6 py-12 text-center">
          <Brain className="mx-auto mb-4 h-8 w-8 text-muted-foreground" />
          <h3 className="font-medium">No memories yet</h3>
          <p className="mt-2 text-sm text-muted-foreground">When this agent saves something to remember, it will appear here.</p>
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">What this agent remembers across conversations. Open a memory to read or edit it.</p>
          <Input aria-label="Search memories" placeholder="Search memories…" value={search} onChange={event => setSearch(event.target.value)} />
          {filtered.filter(entry => entry.isIndex).map(entry => <MemoryRow key={entry.path} entry={entry} onClick={() => setSelected(entry.path)} />)}
          {filtered.some(entry => !entry.isIndex) && (
            <div className="overflow-hidden rounded-xl border divide-y">
              {filtered.filter(entry => !entry.isIndex).map(entry => <MemoryRow key={entry.path} entry={entry} onClick={() => setSelected(entry.path)} grouped />)}
            </div>
          )}
          {filtered.length === 0 && <p className="text-sm text-muted-foreground">No memories match your search.</p>}
        </div>
      )}
    </SettingsPageContainer>
  )
}

function MemoryRow({ entry, onClick, grouped = false }: { entry: AgentMemoryEntry; onClick: () => void; grouped?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 p-4 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${grouped ? '' : 'rounded-xl border'}`}>
      {entry.isIndex ? <FileText className="h-5 w-5 shrink-0 text-muted-foreground" /> : <Brain className="h-5 w-5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium">{entry.title}</span>
        {entry.description && <span className="mt-1 block break-words text-sm text-muted-foreground">{entry.description}</span>}
        <span className="mt-1 block break-all text-xs text-muted-foreground">{entry.path}{entry.type ? ` · ${entry.type}` : ''}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function MemoryDetail({ agentSlug, path, entries, onBack, onSelect }: {
  agentSlug: string; path: string; entries: AgentMemoryEntry[]; onBack: () => void; onSelect: (path: string) => void
}) {
  const memory = useAgentMemory(agentSlug, path)
  const save = useSaveAgentMemory(agentSlug)
  // Snapshot both content and revision at Edit; background refetches must never
  // replace the user's draft or advance the revision they are editing against.
  const [draft, setDraft] = useState<{ content: string; original: string; revision: string } | null>(null)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const dirty = draft !== null && draft.content !== draft.original
  const blocker = useBlocker({
    shouldBlockFn: () => dirty || save.isPending,
    enableBeforeUnload: dirty || save.isPending,
    withResolver: true,
  })
  const requestAction = (action: () => void) => {
    if (save.isPending) return
    if (dirty) setPendingAction(() => action)
    else action()
  }
  const discard = () => {
    setDraft(null)
    save.reset()
    if (blocker.status === 'blocked') blocker.proceed()
    else pendingAction?.()
    setPendingAction(null)
  }
  const keepEditing = () => {
    if (blocker.status === 'blocked') blocker.reset()
    setPendingAction(null)
  }

  return (
    <SettingsPageContainer>
      <PageTitle title={memory.data?.title ?? path} back={{ label: 'All memories', onClick: () => requestAction(onBack) }}
        actions={!draft && memory.data && !memory.isError && (
          <Button variant="outline" size="sm" onClick={() => {
            const doc = memory.data!
            setDraft({ content: doc.content, original: doc.content, revision: doc.revision })
            save.reset()
          }}><Pencil className="mr-2 h-4 w-4" />Edit</Button>
        )}
      />
      {memory.isLoading ? <Loading /> : memory.isError ? (
        <ErrorMessage message={memory.error.message} retry={() => void memory.refetch()} />
      ) : memory.data && (
        <div className="space-y-4">
          <p className="break-all text-xs text-muted-foreground">{path}</p>
          {draft ? (
            <>
              <label htmlFor="memory-content" className="block text-sm font-medium">Memory contents</label>
              <p className="text-sm text-muted-foreground">{memory.data.isIndex ? 'Edit the Markdown index. Frontmatter is not required.' : 'Keep name and description as non-empty text, and metadata.type as user, feedback, project, or reference.'}</p>
              <Textarea id="memory-content" aria-invalid={save.error instanceof MemoryRequestError && save.error.status === 422} aria-describedby={save.isError ? 'memory-save-error' : undefined} className="min-h-[360px] font-mono text-sm" value={draft.content} disabled={save.isPending}
                onChange={event => setDraft({ ...draft, content: event.target.value })} />
              {save.isError && (
                <div role="alert" className="space-y-2">
                  <p id="memory-save-error" className="text-sm text-destructive">{save.error.message}</p>
                  {save.error instanceof MemoryRequestError && save.error.status === 409 && <Button variant="outline" size="sm" onClick={() => requestAction(() => {
                    setDraft(null)
                    save.reset()
                    void memory.refetch()
                  })}>Reload latest version</Button>}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={save.isPending} onClick={() => requestAction(() => { setDraft(null); save.reset() })}>Cancel</Button>
                <Button disabled={!dirty || save.isPending} onClick={() => {
                  save.mutate({ path, content: draft.content, revision: draft.revision }, { onSuccess: () => setDraft(null) })
                }}>{save.isPending ? 'Saving…' : 'Save'}</Button>
              </div>
            </>
          ) : (
            <>
              {memory.data.description && <p className="text-sm text-muted-foreground">{memory.data.description}</p>}
              {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Memory saved.</p>}
              <div className="prose prose-sm max-w-none break-words rounded-xl border p-5 dark:prose-invert">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                  a: ({ href, children }) => {
                    const target = entries.find(entry => entry.path === href || entry.path === `${path.split('/').slice(0, -1).join('/')}/${href}`)
                    return target ? (
                      <button type="button" className="text-primary underline" onClick={() => onSelect(target.path)}>{children}</button>
                    ) : href && /^https?:\/\//.test(href) ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                    ) : <span>{children}</span>
                  },
                }}>{memory.data.body || '*This memory is empty.*'}</ReactMarkdown>
              </div>
            </>
          )}
        </div>
      )}
      <AlertDialog open={pendingAction !== null || blocker.status === 'blocked'} onOpenChange={open => { if (!open) keepEditing() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>Your changes to this memory have not been saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={keepEditing}>Keep editing</AlertDialogCancel>
            <AlertDialogAction disabled={save.isPending} onClick={discard}>Discard changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPageContainer>
  )
}

function Loading() {
  return <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading memories…</div>
}

function ErrorMessage({ message, retry }: { message: string; retry: () => void }) {
  return <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{message}</p><Button variant="outline" size="sm" onClick={retry}>Try again</Button></div>
}
