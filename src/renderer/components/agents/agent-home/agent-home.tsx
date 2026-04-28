
import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ArrowUp, Loader2, Eye, Settings2, Maximize2, Minimize2, Search, ArrowUpDown, Check } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useCreateSession, useSessions } from '@renderer/hooks/use-sessions'
import { useScheduledTasks } from '@renderer/hooks/use-scheduled-tasks'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { RelatedSessions, type SortOrder } from '@renderer/components/sessions/related-sessions'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import { toast } from 'sonner'
import { apiFetch } from '@renderer/lib/api'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { EffortSelector } from '@renderer/components/messages/effort-selector'
import type { EffortLevel } from '@shared/lib/container/types'
import { HomeCrons } from './home-crons'
import { HomeSkills } from './home-skills'
import { HomeExtras } from './home-extras'
import { HomeConnections } from './home-connections'
import { HomeVolumes } from './home-volumes'
import { HomeBookmarks } from './home-bookmarks'
import { useUpdateAgent, useDeleteAgent, type ApiAgent } from '@renderer/hooks/use-agents'
import { AgentCreationAids } from '@renderer/components/agents/agent-creation-aids'
import {
  useTypewriterPlaceholder,
  DEFAULT_AGENT_PROMPT_EXAMPLES,
  DISABLED as TYPEWRITER_DISABLED,
} from '@renderer/hooks/use-typewriter-placeholder'
import { UNTITLED_AGENT_NAME } from '@renderer/hooks/use-create-untitled-agent'
import { useRenameUntitledAgent } from '@renderer/hooks/use-rename-untitled-agent'
import { useRenderTracker } from '@renderer/lib/perf'
import { formatDistanceToNow } from 'date-fns'

interface AgentHomeProps {
  agent: ApiAgent
  onSessionCreated: (sessionId: string, initialMessage: string) => void
  onOpenSettings?: (tab?: string) => void
}

export function AgentHome({ agent, onSessionCreated, onOpenSettings }: AgentHomeProps) {
  useRenderTracker('AgentHome')
  const { selectScheduledTask, selectAgent, consumePendingDraft } = useSelection()
  const { canUseAgent, canAdminAgent } = useUser()
  const isViewOnly = !canUseAgent(agent.slug)
  const isOwner = canAdminAgent(agent.slug)
  const [isExpanded, setIsExpanded] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
  const [sessionSort, setSessionSort] = useState<SortOrder>('newest')
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false)
  const [effort, setEffort] = useState<EffortLevel>('high')
  const sessionSearchRef = useRef<HTMLInputElement>(null)
  const createSession = useCreateSession()
  const updateAgent = useUpdateAgent()
  const deleteAgent = useDeleteAgent()
  const renameUntitledAgent = useRenameUntitledAgent()
  // Tracks whether a name has already been assigned (e.g. by the voice agent)
  // so the post-submit deriveAgentName fallback doesn't clobber it.
  const nameAssignedRef = useRef(false)
  const [isEditingName, setIsEditingName] = useState(false)
  const [editedName, setEditedName] = useState(agent.name)

  const handleStartRename = () => {
    setEditedName(agent.name)
    setIsEditingName(true)
  }

  const handleCancelRename = () => {
    setIsEditingName(false)
    setEditedName(agent.name)
  }

  const handleSaveRename = async () => {
    const trimmed = editedName.trim()
    if (!trimmed || trimmed === agent.name) {
      handleCancelRename()
      return
    }
    try {
      await updateAgent.mutateAsync({ slug: agent.slug, name: trimmed })
      setIsEditingName(false)
    } catch (error) {
      console.error('Failed to rename agent:', error)
      toast.error('Failed to rename agent', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
    }
  }

  const { data: sessionsData } = useSessions(agent.slug)
  const sessions = useMemo(() => {
    if (!Array.isArray(sessionsData)) return []
    return sessionsData.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date(s.createdAt).toISOString(),
      isActive: s.isActive,
      isAwaitingInput: s.isAwaitingInput,
      hasUnreadNotifications: s.hasUnreadNotifications,
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
      const shouldRename =
        agent.name === UNTITLED_AGENT_NAME && sessions.length === 0 && !nameAssignedRef.current
      const session = await createSession.mutateAsync({
        agentSlug: agent.slug,
        message: content,
        effort,
      })
      onSessionCreated(session.id, content)
      // Fire rename after the session is created + navigated — the mutation
      // survives AgentHome unmounting since the queryClient is app-scoped.
      if (shouldRename) {
        nameAssignedRef.current = true
        renameUntitledAgent.mutate({ slug: agent.slug, prompt: content })
      }
    }, [createSession, agent.slug, agent.name, onSessionCreated, effort, sessions.length, renameUntitledAgent]),
    submitDisabled: createSession.isPending || !isRuntimeReady,
    keepMessageUntilComplete: true,
    draftKey: `agent:${agent.slug}`,
  })

  // Consume any pending draft from voice agent flow
  useEffect(() => {
    const draft = consumePendingDraft()
    if (draft) {
      composer.setMessage(draft)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on mount
  }, [])

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

  const isFreshUntitled = agent.name === UNTITLED_AGENT_NAME && sessions.length === 0
  const typewriterPlaceholder = useTypewriterPlaceholder(
    isFreshUntitled ? DEFAULT_AGENT_PROMPT_EXAMPLES : TYPEWRITER_DISABLED,
  )
  const composerPlaceholder = isFreshUntitled
    ? typewriterPlaceholder
    : 'How can I help? Press cmd+enter to send'

  const handleVoiceResult = useCallback(
    ({ name, prompt }: { name: string; prompt: string }) => {
      if (prompt) composer.setMessage(prompt)
      if (name && agent.name === UNTITLED_AGENT_NAME) {
        nameAssignedRef.current = true
        updateAgent.mutate({ slug: agent.slug, name })
      }
    },
    [composer, agent.name, agent.slug, updateAgent],
  )

  const handleImportComplete = useCallback(
    async ({ agent: imported }: { agent: ApiAgent }) => {
      selectAgent(imported.slug)
      if (agent.name === UNTITLED_AGENT_NAME && sessions.length === 0 && agent.slug !== imported.slug) {
        deleteAgent.mutate(agent.slug)
      }
    },
    [selectAgent, agent.slug, agent.name, sessions.length, deleteAgent],
  )

  const formatDate = useCallback(
    (dateStr: string) => formatDistanceToNow(new Date(dateStr), { addSuffix: true }),
    [],
  )

  const showRightColumn = !isViewOnly

  return (
    <div className="flex-1 flex flex-col overflow-y-auto px-10 py-10 bg-background">
      <div className={`grid gap-10 items-start ${showRightColumn ? 'grid-cols-1 xl:grid-cols-[1fr_minmax(320px,400px)] w-full max-w-6xl mx-auto' : 'max-w-2xl mx-auto'}`}>
        {/* Left Column — Chat composer + Sessions */}
        <div className="space-y-6 w-full min-w-0 xl:min-w-[480px] xl:max-w-[720px]">
          <div className="flex items-center justify-between gap-2">
            {isEditingName && isOwner ? (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Input
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleSaveRename()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      handleCancelRename()
                    }
                  }}
                  autoFocus
                  disabled={updateAgent.isPending}
                  className="h-9 text-xl font-semibold"
                  data-testid="agent-name-input"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  onClick={handleSaveRename}
                  disabled={updateAgent.isPending}
                  aria-label="Save name"
                  data-testid="agent-name-save"
                >
                  {updateAgent.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                </Button>
              </div>
            ) : isOwner ? (
              <button
                type="button"
                className="text-xl font-semibold truncate text-left cursor-pointer hover:opacity-80"
                onClick={handleStartRename}
                data-testid="agent-name"
              >
                {agent.name}
              </button>
            ) : (
              <h1 className="text-xl font-semibold truncate" data-testid="agent-name">
                {agent.name}
              </h1>
            )}
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => onOpenSettings?.()} aria-label="Agent settings" data-testid="agent-settings-button">
              <Settings2 className="h-4 w-4" />
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
                  placeholder={composerPlaceholder}
                  disabled={isDisabled}
                  rows={2}
                  autoFocus
                  dataTestId="home-message-input"
                  textareaClassName={`transition-[min-height] duration-300 ease-in-out ${isExpanded ? 'min-h-[50vh]' : 'min-h-[60px]'}`}
                  leftActions={(
                    <>
                      <AttachmentPicker
                        onFileSelect={composer.handleFileSelect}
                        onFolderSelect={composer.handleFolderSelect}
                        onRecentFileAttach={(file) => composer.addFiles([{ file }])}
                        disabled={isDisabled}
                      />
                      <EffortSelector
                        value={effort}
                        onChange={setEffort}
                        disabled={isDisabled}
                      />
                    </>
                  )}
                  topRightActions={(
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground/50 hover:text-foreground"
                      onClick={() => setIsExpanded((v) => !v)}
                      aria-label={isExpanded ? 'Shrink input' : 'Expand input'}
                    >
                      {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                  rightActions={(
                    <>
                      <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
                      {isFreshUntitled ? (
                        <Button
                          type="submit"
                          size="sm"
                          data-testid="home-send-button"
                        >
                          {isDisabled ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                              Creating...
                            </>
                          ) : (
                            'Create Agent'
                          )}
                        </Button>
                      ) : (
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
                      )}
                    </>
                  )}
                  footer={(
                    <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} className="mt-2 justify-center" />
                  )}
                />
              </form>

              {/* Sessions list / creation aids */}
              <div className="pt-2">
                {sessions.length > 0 ? (
                  <>
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
                    <RelatedSessions
                      sessions={sessions}
                      agentSlug={agent.slug}
                      formatDate={formatDate}
                      showIcon={false}
                      showHeader={false}
                      searchQuery={sessionSearch}
                      sortOrder={sessionSort}
                    />
                  </>
                ) : (
                  <AgentCreationAids
                    onVoiceResult={handleVoiceResult}
                    onImportComplete={handleImportComplete}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/* Right Column — Crons + Connections + Skills + Volumes */}
        {showRightColumn && (
          <div className="space-y-3">
            {isOwner && (
              <HomeCrons
                agentSlug={agent.slug}
                scheduledTasks={scheduledTasks}
                formatDate={formatDate}
                onSelectTask={selectScheduledTask}
              />
            )}
            <HomeBookmarks agentSlug={agent.slug} isOwner={isOwner} />
            {isOwner && <HomeConnections agentSlug={agent.slug} />}
            {isOwner && <HomeSkills agentSlug={agent.slug} />}
            {isOwner && <HomeVolumes agentSlug={agent.slug} />}
            {isOwner && <HomeExtras agentSlug={agent.slug} onOpenSettings={onOpenSettings} />}
          </div>
        )}
      </div>
    </div>
  )
}
