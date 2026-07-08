import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { AgentMenu } from '@renderer/components/quick-dispatch/quick-dispatch-menus'
import { readLocalFileAsFile } from '@renderer/lib/read-local-file'
import { useAgents } from '@renderer/hooks/use-agents'
import type { ClassifiedImportPackage } from '@shared/lib/utils/package-extensions'
import { useImportAgentTemplate, type ImportProgress } from '@renderer/hooks/use-agent-templates'
import { useImportSkillZip } from '@renderer/hooks/use-agent-skills'
import { useStartOnboardingSession } from '@renderer/hooks/use-start-onboarding-session'

/**
 * A .agent/.skill package the user opened with the app, already classified by
 * the main process from its zip CONTENT (root CLAUDE.md vs SKILL.md) — the
 * file extension is never trusted for routing. Only the verdict lives here;
 * the bytes stay on disk until the user confirms the import.
 */
type OpenedPackage = Extract<ClassifiedImportPackage, { kind: 'agent-template' | 'skill' }>

/**
 * Routes .agent/.skill files opened with the app (double-click / "Open With" /
 * dock drop) into the matching import flow. Mirrors MenuCommandHandler's
 * shape: mounted once in RootLayout, owns both the live
 * `import-package-pending` ping and the mount-time drain of packages queued
 * while no renderer existed (cold start). Packages are confirmed one at a
 * time — the head of the queue drives the dialog:
 *   agent template → confirm → create agent → navigate/onboarding
 *   skill          → pick the receiving agent → import into it
 */
export function PackageImportHandler() {
  const navigate = useNavigate()
  const { data: agents, isError: agentsError } = useAgents()
  const importTemplate = useImportAgentTemplate()
  const importSkill = useImportSkillZip()
  const startOnboardingSession = useStartOnboardingSession()

  const [queue, setQueue] = useState<OpenedPackage[]>([])
  const [importFull, setImportFull] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<ImportProgress | null>(null)
  const current = queue[0] ?? null

  // Re-entrancy guard for the import handlers. The ref (set synchronously,
  // BEFORE the first await) is what actually blocks a double-click — the
  // mutations' isPending only flips after the readLocalFile round-trip, which
  // can take seconds for a large package. The mirroring state re-renders the
  // dialog so the controls disable for that whole window.
  const importingRef = useRef(false)
  const [importing, setImporting] = useState(false)

  const drainOpenedPackages = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.importPackagesDrain) return
    try {
      const packages = await api.importPackagesDrain()
      const valid: OpenedPackage[] = []
      for (const pkg of packages) {
        if ('kind' in pkg) {
          valid.push(pkg)
        } else {
          toast.error(`Could not import "${pkg.fileName}"`, { description: pkg.error })
        }
      }
      if (valid.length > 0) setQueue((q) => [...q, ...valid])
    } catch (error) {
      console.error('Failed to drain opened packages:', error)
    }
  }, [])

  // Live ping (window already open) + mount-time drain (packages opened while
  // the window was closed or before startup finished queue in the main
  // process). Draining twice is harmless — the main-process queue empties on
  // the first pull.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onImportPackagePending?.(() => {
      void drainOpenedPackages()
    })
    void drainOpenedPackages()
    return () => unsubscribe?.()
  }, [drainOpenedPackages])

  // Drops the head of the queue; the next package (if any) opens immediately.
  const closeDialog = useCallback(() => {
    setQueue((q) => q.slice(1))
    setImportFull(false)
    setUploadProgress(null)
    importTemplate.reset()
    importSkill.reset()
  }, [importTemplate, importSkill])

  // The package bytes are read from disk only now, at import time — the path
  // was authorized for read-local-file when the user opened the file.
  const readPackageFile = useCallback(async (pkg: OpenedPackage): Promise<File | null> => {
    const file = await readLocalFileAsFile(pkg.path)
    if (!file) toast.error(`Could not read "${pkg.fileName}"`)
    return file
  }, [])

  const handleImportAgent = useCallback(async () => {
    if (!current || importingRef.current) return
    importingRef.current = true
    setImporting(true)
    try {
      const file = await readPackageFile(current)
      if (!file) {
        closeDialog()
        return
      }
      try {
        setUploadProgress({ phase: 'uploading', percent: 0 })
        const result = await importTemplate.mutateAsync({
          file,
          mode: importFull ? 'full' : 'template',
          onProgress: setUploadProgress,
        })
        closeDialog()
        toast.success(`Imported agent "${result.name}"`)
        void navigate({ to: '/agents/$slug', params: { slug: result.displaySlug } })
        if (result.hasOnboarding) {
          await startOnboardingSession(result.slug)
        }
      } catch {
        // Error surfaces in the dialog via importTemplate.error
        setUploadProgress(null)
      }
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }, [current, readPackageFile, importFull, importTemplate, closeDialog, navigate, startOnboardingSession])

  const handleImportSkill = useCallback(async (agentSlug: string) => {
    if (!current || importingRef.current) return
    importingRef.current = true
    setImporting(true)
    try {
      const target = agents?.find((a) => a.slug === agentSlug)
      const file = await readPackageFile(current)
      if (!file) {
        closeDialog()
        return
      }
      try {
        const result = await importSkill.mutateAsync({ agentSlug, file })
        closeDialog()
        toast.success(`Added skill "${result.skillName}" to ${target?.name ?? 'agent'}`)
        void navigate({ to: '/agents/$slug', params: { slug: target?.displaySlug ?? agentSlug } })
      } catch {
        // Error surfaces in the dialog via importSkill.error
      }
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }, [current, agents, readPackageFile, importSkill, closeDialog, navigate])

  const busy = importing || importTemplate.isPending || importSkill.isPending

  return (
    <Dialog open={current !== null} onOpenChange={(open) => { if (!open && !busy) closeDialog() }}>
      <DialogContent className="max-w-lg">
        {current?.kind === 'agent-template' ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-medium">Import Agent</DialogTitle>
              <DialogDescription>
                Create a new agent{current.name ? ` "${current.name}"` : ''} from{' '}
                <span className="font-medium text-foreground">{current.fileName}</span>?
              </DialogDescription>
            </DialogHeader>
            <div className="py-2 space-y-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="package-import-full"
                  checked={importFull}
                  onCheckedChange={(checked) => setImportFull(checked === true)}
                  disabled={busy}
                />
                <label
                  htmlFor="package-import-full"
                  className="text-sm text-muted-foreground cursor-pointer select-none"
                >
                  Import includes env. variables and session data
                </label>
              </div>
              {uploadProgress && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      {uploadProgress.phase === 'processing' && <Loader2 className="h-3 w-3 animate-spin" />}
                      {uploadProgress.phase === 'uploading' ? 'Uploading...' : 'Processing...'}
                    </span>
                    {uploadProgress.phase === 'uploading' && <span>{Math.round(uploadProgress.percent)}%</span>}
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{
                        width: uploadProgress.phase === 'processing' ? '100%' : `${uploadProgress.percent}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              {importTemplate.error && (
                <p className="text-sm text-destructive" data-testid="package-import-error">
                  {importTemplate.error.message}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={handleImportAgent} disabled={busy} data-testid="package-import-confirm">
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {uploadProgress?.phase === 'uploading' ? 'Uploading...' : 'Processing...'}
                  </>
                ) : (
                  'Import'
                )}
              </Button>
            </DialogFooter>
          </>
        ) : current ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-medium">Add Skill to an Agent</DialogTitle>
              <DialogDescription>
                Choose which agent should get the skill{current.name ? ` "${current.name}"` : ''} from{' '}
                <span className="font-medium text-foreground">{current.fileName}</span>.
              </DialogDescription>
            </DialogHeader>
            {!agents ? (
              // Still loading (or failed) — never show AgentMenu's "No agents"
              // to a user whose agents just haven't arrived yet.
              agentsError ? (
                <p className="py-4 text-sm text-destructive">
                  Couldn&apos;t load your agents. Close this dialog and open the skill file again.
                </p>
              ) : (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )
            ) : agents.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                You don&apos;t have any agents yet. Create an agent first, then open this skill file again to add it.
              </p>
            ) : (
              <div className="py-2 -mx-2 relative">
                <AgentMenu
                  agents={agents}
                  selectedSlug={undefined}
                  onSelect={(slug) => { if (!busy) void handleImportSkill(slug) }}
                  maxHeight={280}
                />
                {busy && (
                  <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
            )}
            {importSkill.error && (
              <p className="text-sm text-destructive" data-testid="package-import-error">
                {importSkill.error.message}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog} disabled={busy}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
