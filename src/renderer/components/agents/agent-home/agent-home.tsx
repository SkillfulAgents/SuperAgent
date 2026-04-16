
import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ArrowUp, Loader2, Eye, MoreVertical, Maximize2, Minimize2, Search, ArrowUpDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useCreateSession, useSessions } from '@renderer/hooks/use-sessions'
import { useScheduledTasks } from '@renderer/hooks/use-scheduled-tasks'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { RelatedSessions, type SortOrder } from '@renderer/components/sessions/related-sessions'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { HomeCrons } from './home-crons'
import { HomeSkills } from './home-skills'
import { HomeExtras } from './home-extras'
import { HomeBookmarks } from './home-bookmarks'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { useRenderTracker } from '@renderer/lib/perf'
import { formatDistanceToNow } from 'date-fns'

interface AgentHomeProps {
  agent: ApiAgent
  onSessionCreated: (sessionId: string, initialMessage: string) => void
  onOpenSettings?: (tab?: string) => void
}

export function AgentHome({ agent, onSessionCreated, onOpenSettings }: AgentHomeProps) {
  useRenderTracker('AgentHome')
  const { selectScheduledTask } = useSelection()
  const { canUseAgent, canAdminAgent } = useUser()
  const isViewOnly = !canUseAgent(agent.slug)
  const isOwner = canAdminAgent(agent.slug)
  const [isExpanded, setIsExpanded] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
  const [sessionSort, setSessionSort] = useState<SortOrder>('newest')
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false)
  const sessionSearchRef = useRef<HTMLInputElement>(null)
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

  const isDisabled = createSession.isPending || composer.isUploading || !isRuntimeReady

  const formatDate = useCallback(
    (dateStr: string) => formatDistanceToNow(new Date(dateStr), { addSuffix: true }),
    [],
  )

  const showRightColumn = isOwner

  return (
    <div className="flex-1 flex flex-col overflow-y-auto px-10 py-10 bg-sidebar">
      <div className={`grid gap-10 items-start ${showRightColumn ? 'grid-cols-1 xl:grid-cols-[1fr_minmax(320px,400px)] w-full max-w-6xl mx-auto' : 'max-w-2xl mx-auto'}`}>
        {/* Left Column — Chat composer + Sessions */}
        <div className="space-y-6 w-full min-w-0 xl:min-w-[480px] xl:max-w-[720px]">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-semibold">{agent.name}</h1>
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => onOpenSettings?.()} aria-label="Agent settings">
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
                  dataTestId="home-message-input"
                  textareaClassName={`transition-[min-height] duration-300 ease-in-out ${isExpanded ? 'min-h-[50vh]' : 'min-h-[60px]'}`}
                  leftActions={(
                    <AttachmentPicker
                      onFileSelect={composer.handleFileSelect}
                      onFolderSelect={composer.handleFolderSelect}
                      onRecentFileAttach={(file) => composer.addFiles([{ file }])}
                      disabled={isDisabled}
                    />
                  )}
                  rightActions={(
                    <>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-[34px] w-[34px]"
                        onClick={() => setIsExpanded((v) => !v)}
                        aria-label={isExpanded ? 'Shrink input' : 'Expand input'}
                      >
                        {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                      </Button>
                      <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
                      <Button
                        type="submit"
                        size="icon"
                        className="h-[34px] w-[34px]"
                        disabled={!composer.canSubmit}
                        data-testid="home-send-button"
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

              {/* Bookmarks */}
              <HomeBookmarks agentSlug={agent.slug} isOwner={isOwner} />

              {/* Sessions list */}
              <div className="pt-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-medium text-muted-foreground flex-1">Sessions</h2>
                  <Popover open={sortPopoverOpen} onOpenChange={setSortPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button type="button" size="icon" variant="ghost" className="h-6 w-6 shrink-0" aria-label="Sort sessions">
                        <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-40 p-1">
                      <button
                        className={`flex w-full items-center rounded-sm px-2 py-1.5 text-xs transition-colors ${sessionSort === 'newest' ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
                        onClick={() => { setSessionSort('newest'); setSortPopoverOpen(false) }}
                      >
                        Newest first
                      </button>
                      <button
                        className={`flex w-full items-center rounded-sm px-2 py-1.5 text-xs transition-colors ${sessionSort === 'oldest' ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
                        onClick={() => { setSessionSort('oldest'); setSortPopoverOpen(false) }}
                      >
                        Oldest first
                      </button>
                    </PopoverContent>
                  </Popover>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0"
                    onClick={() => {
                      const next = !sessionSearchOpen
                      setSessionSearchOpen(next)
                      if (!next) setSessionSearch('')
                      else setTimeout(() => sessionSearchRef.current?.focus(), 0)
                    }}
                    aria-label="Search sessions"
                  >
                    <Search className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                  {sessionSearchOpen && (
                    <Input
                      ref={sessionSearchRef}
                      value={sessionSearch}
                      onChange={(e) => setSessionSearch(e.target.value)}
                      placeholder="Filter sessions..."
                      className="h-6 text-xs flex-1"
                    />
                  )}
                </div>
                <div className="border-b mt-2" />
                {sessions.length > 0 ? (
                  <RelatedSessions
                    sessions={sessions}
                    agentSlug={agent.slug}
                    formatDate={formatDate}
                    showIcon={false}
                    showHeader={false}
                    searchQuery={sessionSearch}
                    sortOrder={sessionSort}
                  />
                ) : (
                  <div className="rounded-lg border border-dashed p-4 mt-3">
                    <p className="text-xs text-muted-foreground">No sessions yet. Send a message to start one.</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right Column — Crons + Skills */}
        {showRightColumn && (
          <div className="space-y-3">
            <HomeCrons
              agentSlug={agent.slug}
              scheduledTasks={scheduledTasks}
              formatDate={formatDate}
              onSelectTask={selectScheduledTask}
            />
            <HomeSkills agentSlug={agent.slug} />
            <HomeExtras agentSlug={agent.slug} onOpenSettings={onOpenSettings} />
          </div>
        )}
      </div>
    </div>
  )
}
