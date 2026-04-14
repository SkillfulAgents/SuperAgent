
import { useState, useMemo, useCallback, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { ArrowUp, Loader2, Search, ChevronLeft, ChevronRight, ChevronDown, Filter, Eye, MoreVertical, FileCode, CloudUpload, Play, ExternalLink, Trash2 } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@renderer/components/ui/collapsible'
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
import { useCreateSession, useSessions } from '@renderer/hooks/use-sessions'
import { useScheduledTasks, useRunScheduledTaskNow, useCancelScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import { useHumanizedCron } from '@renderer/hooks/use-humanized-cron'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useAgentSkills, useDiscoverableSkills } from '@renderer/hooks/use-agent-skills'
import { DiscoverableSkillCard } from './discoverable-skill-card'
import { StatusBadge } from './status-badge'
import { SkillFilesDialog } from './skill-files-dialog'
import { SkillPublishDialog } from './skill-publish-dialog'
import { RelatedSessions } from '@renderer/components/sessions/related-sessions'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import type { ApiSkillWithStatus, ApiScheduledTask } from '@shared/lib/types/api'
import { useRenderTracker } from '@renderer/lib/perf'
import { formatDistanceToNow } from 'date-fns'

interface AgentLandingProps {
  agent: ApiAgent
  onSessionCreated: (sessionId: string, initialMessage: string) => void
  onOpenSettings?: () => void
}

export function AgentLanding({ agent, onSessionCreated, onOpenSettings }: AgentLandingProps) {
  useRenderTracker('AgentLanding')
  const { selectScheduledTask } = useSelection()
  const { canUseAgent, canAdminAgent } = useUser()
  const isViewOnly = !canUseAgent(agent.slug)
  const isOwner = canAdminAgent(agent.slug)
  const [isExpanded, setIsExpanded] = useState(false)
  const [skillSearch, setSkillSearch] = useState('')
  const [skillPage, setSkillPage] = useState(0)
  const [selectedSkillsets, setSelectedSkillsets] = useState<Set<string> | null>(null)
  const SKILLS_PER_PAGE = 6
  const createSession = useCreateSession()

  const { data: sessionsData } = useSessions(agent.slug)
  const sessions = useMemo(() => {
    if (!Array.isArray(sessionsData)) return []
    return sessionsData.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date(s.createdAt).toISOString(),
      isActive: s.isActive,
    }))
  }, [sessionsData])

  const { data: scheduledTasksData } = useScheduledTasks(agent.slug, 'pending')
  const scheduledTasks = useMemo(() => Array.isArray(scheduledTasksData) ? scheduledTasksData : [], [scheduledTasksData])

  const { data: skillsData } = useAgentSkills(agent.slug)
  const skills = Array.isArray(skillsData) ? skillsData : []
  const { data: discoverableSkillsData } = useDiscoverableSkills(agent.slug)
  const discoverableSkills = useMemo(() => Array.isArray(discoverableSkillsData) ? discoverableSkillsData : [], [discoverableSkillsData])
  const { data: runtimeStatus, isPending: isRuntimePending } = useRuntimeStatus()
  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeReady = isRuntimePending || readiness?.status === 'READY'
  const isPulling = readiness?.status === 'PULLING_IMAGE'
  const apiKeyConfigured = runtimeStatus?.apiKeyConfigured !== false

  const composer = useMessageComposer({
    agentSlug: agent.slug,
    uploadFile: useCallback(async ({ file }: { file: File }) => {
      const formData = new FormData()
      formData.append('file', file)
      const res = await apiFetch(
        `/api/agents/${agent.slug}/upload-file`,
        { method: 'POST', body: formData }
      )
      if (!res.ok) throw new Error('Failed to upload file')
      return res.json() as Promise<{ path: string }>
    }, [agent.slug]),
    uploadFolder: useCallback(async ({ sourcePath }: { sourcePath: string }) => {
      const res = await apiFetch(
        `/api/agents/${agent.slug}/upload-folder`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourcePath }),
        }
      )
      if (!res.ok) throw new Error('Failed to upload folder')
      return res.json() as Promise<{ path: string }>
    }, [agent.slug]),
    onSubmit: useCallback(async (content: string) => {
      const session = await createSession.mutateAsync({
        agentSlug: agent.slug,
        message: content,
      })
      onSessionCreated(session.id, content)
    }, [createSession, agent.slug, onSessionCreated]),
    submitDisabled: createSession.isPending || !isRuntimeReady,
    keepMessageUntilComplete: true,
  })

  // Auto-expand when message gets long (5+ lines)
  useEffect(() => {
    const lineCount = composer.message.split('\n').length
    if (lineCount >= 5 && !isExpanded) {
      setIsExpanded(true)
    }
  }, [composer.message, isExpanded])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      composer.handleSubmit(e)
    }
  }

  // Unique skillsets from discoverable skills
  const skillsetList = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of discoverableSkills) {
      if (!seen.has(s.skillsetId)) seen.set(s.skillsetId, s.skillsetName)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [discoverableSkills])

  // Effective selected skillsets: null means all selected
  const activeSkillsets = useMemo(
    () => selectedSkillsets ?? new Set(skillsetList.map((s) => s.id)),
    [selectedSkillsets, skillsetList]
  )

  const filteredSkills = useMemo(() => {
    return discoverableSkills.filter((s) => {
      if (!activeSkillsets.has(s.skillsetId)) return false
      if (!skillSearch.trim()) return true
      const q = skillSearch.toLowerCase()
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    })
  }, [discoverableSkills, skillSearch, activeSkillsets])

  const totalPages = Math.ceil(filteredSkills.length / SKILLS_PER_PAGE)
  const pagedSkills = filteredSkills.slice(
    skillPage * SKILLS_PER_PAGE,
    (skillPage + 1) * SKILLS_PER_PAGE
  )

  // Reset page when search or filter changes
  useEffect(() => {
    setSkillPage(0)
  }, [skillSearch, selectedSkillsets])

  const isDisabled = createSession.isPending || composer.isUploading || !isRuntimeReady

  const formatDate = useCallback(
    (dateStr: string) => formatDistanceToNow(new Date(dateStr), { addSuffix: true }),
    [],
  )

  const showRightColumn = isOwner && !isExpanded

  return (
    <div className="flex-1 flex flex-col overflow-y-auto px-16 py-8 bg-sidebar">
      <div className={`grid gap-10 items-start mt-10 ${showRightColumn ? 'grid-cols-1 lg:grid-cols-[1fr_minmax(320px,400px)] w-full max-w-6xl mx-auto' : 'max-w-2xl mx-auto'}`}>
        {/* Left Column — Chat composer + Sessions */}
        <div className="space-y-6 w-full min-w-0 lg:min-w-[480px] max-w-[720px]">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-semibold">{agent.name}</h1>
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={onOpenSettings}>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </div>
          {isViewOnly ? (
            <div className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground border rounded-lg p-6" data-testid="view-only-banner">
              <Eye className="h-5 w-5" />
              <span>Select a session from the sidebar to view its messages</span>
            </div>
          ) : (
            <>
              {!apiKeyConfigured && (
                <div className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground">
                  <span>No API key configured. An administrator needs to set up the LLM API key.</span>
                </div>
              )}
              {!isRuntimeReady && readiness && (
                <div className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground">
                  {isPulling && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span>{readiness.message}</span>
                  {readiness.pullProgress?.percent != null && (
                    <span>({readiness.pullProgress.status} - {readiness.pullProgress.percent}%)</span>
                  )}
                </div>
              )}

              <MountChoiceDialog
                open={composer.mountDialog.open}
                onChoice={composer.mountDialog.onChoice}
                folderName={composer.mountDialog.folderName}
              />
              <form
                onSubmit={composer.handleSubmit}
                className={composer.isDragOver ? 'rounded-2xl ring-2 ring-primary ring-inset' : ''}
                {...composer.dragHandlers}
              >
                <ChatComposerBox
                  attachments={composer.attachments}
                  onRemoveAttachment={composer.removeAttachment}
                  value={composer.message}
                  onChange={(e) => composer.setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={composer.handlePaste}
                  placeholder="How can I help? Press cmd+enter to send"
                  disabled={isDisabled}
                  rows={2}
                  autoFocus
                  dataTestId="landing-message-input"
                  textareaClassName={`transition-[min-height] duration-300 ease-in-out ${isExpanded ? 'min-h-[50vh]' : 'min-h-[60px]'}`}
                  leftActions={(
                    <AttachmentPicker
                      onFileSelect={composer.handleFileSelect}
                      onFolderSelect={composer.handleFolderSelect}
                      disabled={isDisabled}
                    />
                  )}
                  rightActions={(
                    <>
                      <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
                      <Button
                        type="submit"
                        size="icon"
                        className="h-[34px] w-[34px]"
                        disabled={!composer.canSubmit}
                        data-testid="landing-send-button"
                        aria-label="Send message"
                      >
                        {isDisabled ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <ArrowUp className="h-4 w-4" />
                        )}
                      </Button>
                    </>
                  )}
                  footer={(
                    <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} className="mt-2 justify-center" />
                  )}
                />
              </form>

              {/* Sessions list */}
              {!isExpanded && (
                <div className="pt-2">
                  <h2 className="text-sm font-medium text-muted-foreground">Sessions</h2>
                  <div className="border-b mt-2" />
                  {sessions.length > 0 ? (
                    <RelatedSessions
                      sessions={sessions}
                      agentSlug={agent.slug}
                      formatDate={formatDate}
                      showIcon={false}
                      showHeader={false}
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed p-4 mt-3">
                      <p className="text-xs text-muted-foreground">No sessions yet. Send a message to start one.</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Right Column — Scheduled Tasks + Skills */}
        {showRightColumn && (
          <div className="space-y-3">
            {/* Scheduled Tasks Section */}
            <Collapsible defaultOpen>
              <div className="rounded-xl border bg-background py-4">
                <CollapsibleTrigger className="flex w-full items-center justify-between px-4">
                  <span className="text-sm font-medium text-muted-foreground">Crons</span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {scheduledTasks.length > 0 ? (
                    <div className="mt-2 divide-y divide-border/50">
                      {scheduledTasks.map((task) => (
                        <CronRow key={task.id} task={task} agentSlug={agent.slug} formatDate={formatDate} onSelect={() => selectScheduledTask(task.id)} />
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
                      <p className="text-xs font-medium text-foreground">No crons yet</p>
                      <p className="text-xs mt-1">Crons trigger your agent to do work for you on a schedule. Your agent will create crons for you as needed.</p>
                    </div>
                  )}
                </CollapsibleContent>
              </div>
            </Collapsible>

            {/* Skills Section */}
            <Collapsible defaultOpen>
              <div className="rounded-xl border bg-background py-4">
                <CollapsibleTrigger className="flex w-full items-center justify-between px-4">
                  <span className="text-sm font-medium text-muted-foreground">Skills</span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {skills.length === 0 && discoverableSkills.length === 0 && (
                    <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
                      <p className="text-xs font-medium text-foreground">No skills yet</p>
                      <p className="text-xs mt-1">Skills teach your agent how to do specific tasks, like triaging emails. Your agent builds skills for you as it works.</p>
                    </div>
                  )}

                  {skills.length > 0 && (
                    <div className="mt-2 divide-y divide-border/50">
                      {skills.map((skill) => (
                        <SkillRow key={skill.path} skill={skill} agentSlug={agent.slug} />
                      ))}
                    </div>
                  )}

                  {discoverableSkills.length > 0 && (
                    <>
                      {skills.length > 0 && (
                        <div className="border-t my-3" />
                      )}
                      <div className="flex items-center gap-1.5 mb-2 px-4">
                        <span className="text-[11px] text-muted-foreground">Discover</span>
                        <div className="ml-auto flex items-center gap-1.5">
                          {skillsetList.length > 0 && (
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 relative"
                                  title="Filter by skillset"
                                >
                                  <Filter className="h-3 w-3 text-muted-foreground" />
                                  {selectedSkillsets && selectedSkillsets.size < skillsetList.length && (
                                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary" />
                                  )}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent align="end" className="w-56 p-3">
                                <p className="text-xs font-medium mb-2">Filter by skillset</p>
                                <div className="space-y-2">
                                  {skillsetList.map((ss) => (
                                    <label key={ss.id} className="flex items-center gap-2 cursor-pointer">
                                      <Checkbox
                                        checked={activeSkillsets.has(ss.id)}
                                        onCheckedChange={(checked) => {
                                          const next = new Set(activeSkillsets)
                                          if (checked) {
                                            next.add(ss.id)
                                          } else {
                                            next.delete(ss.id)
                                          }
                                          setSelectedSkillsets(
                                            next.size === skillsetList.length ? null : next
                                          )
                                        }}
                                      />
                                      <span className="text-xs truncate">{ss.name}</span>
                                    </label>
                                  ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                          )}
                          <div className="relative w-36">
                            <Input
                              value={skillSearch}
                              onChange={(e) => setSkillSearch(e.target.value)}
                              placeholder="Search..."
                              className="h-6 text-[11px] pr-6"
                            />
                            <Search className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                          </div>
                        </div>
                      </div>
                      <div className="divide-y divide-border/50 px-4">
                        {pagedSkills.map((skill) => (
                          <DiscoverableSkillCard
                            key={`${skill.skillsetId}/${skill.path}`}
                            skill={skill}
                            agentSlug={agent.slug}
                          />
                        ))}
                        {filteredSkills.length === 0 && skillSearch.trim() && (
                          <p className="text-[11px] text-muted-foreground text-center py-3">
                            No skills matching &ldquo;{skillSearch}&rdquo;
                          </p>
                        )}
                      </div>
                      {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 mt-3">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            onClick={() => setSkillPage((p) => p - 1)}
                            disabled={skillPage === 0}
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                          </Button>
                          <span className="text-[11px] text-muted-foreground">
                            {skillPage + 1} / {totalPages}
                          </span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            onClick={() => setSkillPage((p) => p + 1)}
                            disabled={skillPage >= totalPages - 1}
                          >
                            <ChevronRight className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>
        )}
      </div>
    </div>
  )
}

function SkillRow({ skill, agentSlug }: { skill: ApiSkillWithStatus; agentSlug: string }) {
  const [filesOpen, setFilesOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)

  return (
    <>
      <div className="group relative py-3 px-4 hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setFilesOpen(true)}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate">{skill.name ?? skill.path}</span>
          <StatusBadge status={skill.status} />
        </div>
        {skill.description && (
          <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">{skill.description}</div>
        )}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-36 p-1">
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={() => setFilesOpen(true)}
              >
                <FileCode className="h-3.5 w-3.5" />
                View Files
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={() => setPublishOpen(true)}
              >
                <CloudUpload className="h-3.5 w-3.5" />
                Publish Skill
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
      />
    </>
  )
}

function CronRow({ task, agentSlug, formatDate, onSelect }: { task: ApiScheduledTask; agentSlug: string; formatDate: (dateStr: string) => string; onSelect: () => void }) {
  const runNow = useRunScheduledTaskNow()
  const cancelTask = useCancelScheduledTask()
  const humanizedCron = useHumanizedCron(task.isRecurring ? task.scheduleExpression : null)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  return (
    <>
      <button
        onClick={onSelect}
        className="group relative w-full py-3 px-4 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="text-xs font-medium truncate">{task.name ?? 'Scheduled Task'}</div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-0.5">
          <span>{humanizedCron ?? 'One-time'}</span>
          {task.nextExecutionAt && (
            <span>Next: {formatDate(new Date(task.nextExecutionAt).toISOString())}</span>
          )}
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-36 p-1">
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect()
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View Details
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                disabled={runNow.isPending}
                onClick={(e) => {
                  e.stopPropagation()
                  runNow.mutate({ taskId: task.id, agentSlug })
                }}
              >
                <Play className="h-3.5 w-3.5" />
                {runNow.isPending ? 'Running...' : 'Run Now'}
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDeleteDialog(true)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Cron
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </button>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Cron</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{task.name ?? 'this cron'}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Cron</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelTask.mutate({ id: task.id, agentSlug })}
              disabled={cancelTask.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelTask.isPending ? 'Deleting...' : 'Delete Cron'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
