import { useState, useMemo, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { MoreVertical, FileCode, CloudUpload, GitPullRequest, Send, RefreshCw, Loader2, Plus, Play, Upload, Download, FileArchive, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { StatusBadge } from '../status-badge'
import { SkillFilesDialog } from '../skill-files-dialog'
import { SkillPublishDialog } from '../skill-publish-dialog'
import { SkillPRDialog } from '../skill-pr-dialog'
import { SkillDeleteDialog } from '../skill-delete-dialog'
import { HomeCollapsible } from './home-collapsible'
import { HomeSkillsBrowseDialog } from './home-skills-browse-dialog'
import { useAgentSkills, useDiscoverableSkills, useUpdateSkill, useExportSkill, useImportSkillZip } from '@renderer/hooks/use-agent-skills'
import { useSkillsetPublishMode } from '@renderer/hooks/use-skillsets'
import { getReviewActionLabel, isPullRequestPublishMode } from '@renderer/lib/skillset-publish-ui'
import type { ApiSkillWithStatus } from '@shared/lib/types/api'
import { SKILL_PACKAGE_EXTENSION } from '@shared/lib/utils/package-extensions'

interface HomeSkillsProps {
  agentSlug: string
  className?: string
  onRunSkill?: (skillName: string) => void
}

export function HomeSkills({ agentSlug, className, onRunSkill }: HomeSkillsProps) {
  const [browseOpen, setBrowseOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const { data: skillsData } = useAgentSkills(agentSlug)
  const skills = Array.isArray(skillsData) ? skillsData : []
  const { data: discoverableSkillsData } = useDiscoverableSkills(agentSlug)
  const discoverableSkills = useMemo(
    () => (Array.isArray(discoverableSkillsData) ? discoverableSkillsData : []),
    [discoverableSkillsData]
  )

  const hasDiscoverable = discoverableSkills.length > 0

  return (
    <HomeCollapsible title="Skills" className={className}>
      {skills.length === 0 ? (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No skills yet</p>
          <p className="text-xs mt-1">Skills teach your agent how to do specific tasks, like triaging emails. Your agent builds skills for you as it works.</p>
        </div>
      ) : (
        <div className="mt-2 divide-y divide-border/50" data-testid="installed-skills-list">
          {skills.map((skill) => (
            <SkillRow key={skill.path} skill={skill} agentSlug={agentSlug} onRunSkill={onRunSkill} />
          ))}
        </div>
      )}

      <div className="flex justify-end mt-3 px-4 pb-1 gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setImportOpen(true)}
          data-testid="import-skill-button"
        >
          <Download className="h-3.5 w-3.5" />
          Import
        </Button>
        {hasDiscoverable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setBrowseOpen(true)}
            data-testid="add-skill-button"
          >
            <Plus />
            Add Skill
          </Button>
        )}
      </div>

      <HomeSkillsBrowseDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        agentSlug={agentSlug}
        discoverableSkills={discoverableSkills}
      />
      <SkillImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        agentSlug={agentSlug}
      />
    </HomeCollapsible>
  )
}

function SkillRow({ skill, agentSlug, onRunSkill }: { skill: ApiSkillWithStatus; agentSlug: string; onRunSkill?: (skillName: string) => void }) {
  const [filesOpen, setFilesOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const updateSkill = useUpdateSkill()
  const exportSkill = useExportSkill()
  const publishMode = useSkillsetPublishMode(skill.status.skillsetId)
  const ReviewIcon = isPullRequestPublishMode(publishMode) ? GitPullRequest : Send
  const actionLabel = getReviewActionLabel(publishMode)
  const skillName = skill.name ?? skill.path

  return (
    <>
      <div role="button" tabIndex={0} data-testid="installed-skill-row" data-skill-path={skill.path} className="group relative py-3 px-4 hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setFilesOpen(true)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilesOpen(true) } }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate">{skill.name ?? skill.path}</span>
          <StatusBadge status={skill.status} />
        </div>
        {skill.description && (
          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{skill.description}</div>
        )}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity flex items-center gap-1">
          {onRunSkill && (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-6 w-6"
              aria-label={`Run ${skill.name ?? 'skill'}`}
              onClick={(e) => { e.stopPropagation(); onRunSkill(skill.path) }}
            >
              <Play className="h-3 w-3" />
            </Button>
          )}
          <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label={`Actions for ${skill.name ?? 'skill'}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-36 p-1" onClick={(e) => e.stopPropagation()}>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => { e.stopPropagation(); setActionsOpen(false); setFilesOpen(true) }}
              >
                <FileCode className="h-3.5 w-3.5" />
                View Files
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                disabled={exportSkill.isPending}
                onClick={(e) => {
                  e.stopPropagation()
                  setActionsOpen(false)
                  exportSkill.mutate(
                    { agentSlug, skillDir: skill.path, skillName },
                    { onError: (err) => toast.error('Export failed', { description: err.message }) },
                  )
                }}
              >
                {exportSkill.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                Export Skill
              </button>
              {skill.status.type === 'local' && skill.status.publishable !== false && publishMode !== 'none' && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => { e.stopPropagation(); setActionsOpen(false); setPublishOpen(true) }}
                >
                  <CloudUpload className="h-3.5 w-3.5" />
                  Publish Skill
                </button>
              )}
              {skill.status.type === 'update_available' && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  disabled={updateSkill.isPending}
                  onClick={(e) => { e.stopPropagation(); setActionsOpen(false); updateSkill.mutate({ agentSlug, skillDir: skill.path }) }}
                >
                  {updateSkill.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Update
                </button>
              )}
              {skill.status.type === 'locally_modified' && publishMode !== 'none' && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => { e.stopPropagation(); setActionsOpen(false); setReviewOpen(true) }}
                >
                  <ReviewIcon className="h-3.5 w-3.5" />
                  {actionLabel}
                </button>
              )}
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                onClick={(e) => { e.stopPropagation(); setActionsOpen(false); setDeleteOpen(true) }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Skill
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <SkillFilesDialog
        open={filesOpen}
        onOpenChange={setFilesOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
        skillName={skill.name}
      />
      <SkillPublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
        skillStatus={skill.status}
        onOpenReview={() => setReviewOpen(true)}
      />
      <SkillPRDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
        publishMode={publishMode}
      />
      <SkillDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
        skillName={skillName}
      />
    </>
  )
}

function SkillImportDialog({ open, onOpenChange, agentSlug }: { open: boolean; onOpenChange: (open: boolean) => void; agentSlug: string }) {
  const [importFile, setImportFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importSkill = useImportSkillZip()

  const acceptFile = useCallback((file: File | null | undefined) => {
    if (!file) return
    const name = file.name.toLowerCase()
    if (!name.endsWith(SKILL_PACKAGE_EXTENSION) && !name.endsWith('.zip')) {
      toast.error(`Only ${SKILL_PACKAGE_EXTENSION} or .zip files are supported`)
      return
    }
    setImportFile(file)
  }, [])

  const resetImport = useCallback(() => {
    setImportFile(null)
    importSkill.reset()
  }, [importSkill])

  const closeDialog = useCallback(() => {
    onOpenChange(false)
    resetImport()
  }, [onOpenChange, resetImport])

  const handleImport = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!importFile) return

    try {
      const result = await importSkill.mutateAsync({ agentSlug, file: importFile })
      closeDialog()
      toast.success(`Imported skill "${result.skillName}"`)
    } catch {
      // Error is shown by the mutation's error state
    }
  }, [importFile, importSkill, agentSlug, closeDialog])

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault()
    acceptFile(e.dataTransfer.files[0])
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) closeDialog() }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-medium">Import a Skill</DialogTitle>
            <DialogDescription className="sr-only">
              Upload a .skill or .zip file to import a skill.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleImport}>
            <div className="py-4 space-y-4">
              <div
                className={`border border-dashed rounded-lg p-6 text-center transition-colors bg-muted/50 ${
                  importSkill.isPending ? 'opacity-50 pointer-events-none' : 'cursor-pointer'
                }`}
                role="button"
                tabIndex={0}
                onClick={() => !importSkill.isPending && fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !importSkill.isPending) {
                    e.preventDefault()
                    fileInputRef.current?.click()
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={importSkill.isPending ? undefined : handleFileDrop}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={`${SKILL_PACKAGE_EXTENSION},.zip`}
                  className="hidden"
                  disabled={importSkill.isPending}
                  onChange={(e) => {
                    acceptFile(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
                {importFile ? (
                  <div className="flex items-center justify-center gap-2">
                    <FileArchive className="h-5 w-5 text-primary" />
                    <span className="text-sm font-medium">{importFile.name}</span>
                    {!importSkill.isPending && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs"
                        onClick={(e) => {
                          e.stopPropagation()
                          setImportFile(null)
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                    <Download className="h-5 w-5 mx-auto text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">
                      Drop a .skill or .zip file here<br />
                      or click to browse
                    </p>
                  </>
                )}
              </div>

              {importSkill.error && (
                <p className="text-sm text-destructive" data-testid="import-skill-error">
                  {importSkill.error.message}
                </p>
              )}
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={closeDialog} disabled={importSkill.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={!importFile || importSkill.isPending}>
                {importSkill.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Importing...
                  </>
                ) : (
                  'Import'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

    </>
  )
}
