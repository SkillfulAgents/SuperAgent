
import { useState, useMemo, useCallback, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { ArrowUp, Loader2, Sparkles, Search, RefreshCw, ChevronLeft, ChevronRight, Filter, Eye } from 'lucide-react'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useAgentSkills, useDiscoverableSkills, useRefreshAgentSkills } from '@renderer/hooks/use-agent-skills'
import { AgentSkillCard } from './agent-skill-card'
import { DiscoverableSkillCard } from './discoverable-skill-card'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import type { ApiAgent } from '@renderer/hooks/use-agents'

interface AgentLandingProps {
  agent: ApiAgent
  onSessionCreated: (sessionId: string, initialMessage: string) => void
}

export function AgentLanding({ agent, onSessionCreated }: AgentLandingProps) {
  const { canUseAgent, canAdminAgent } = useUser()
  const isViewOnly = !canUseAgent(agent.slug)
  const isOwner = canAdminAgent(agent.slug)
  const [isExpanded, setIsExpanded] = useState(false)
  const [skillSearch, setSkillSearch] = useState('')
  const [skillPage, setSkillPage] = useState(0)
  const [selectedSkillsets, setSelectedSkillsets] = useState<Set<string> | null>(null)
  const SKILLS_PER_PAGE = 6
  const createSession = useCreateSession()

  const { data: skillsData } = useAgentSkills(agent.slug)
  const skills = Array.isArray(skillsData) ? skillsData : []
  const { data: discoverableSkillsData } = useDiscoverableSkills(agent.slug)
  const discoverableSkills = useMemo(() => Array.isArray(discoverableSkillsData) ? discoverableSkillsData : [], [discoverableSkillsData])
  const refreshSkills = useRefreshAgentSkills()
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

  return (
    <div className="flex-1 flex flex-col items-center overflow-y-auto p-8">
      <div className={`w-full space-y-6 my-auto transition-[max-width] duration-300 ease-in-out ${isExpanded ? 'max-w-5xl' : 'max-w-2xl'}`}>
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold">
            {isViewOnly ? agent.name : `Start a conversation with ${agent.name}`}
          </h1>
          <p className="text-muted-foreground">
            {isViewOnly
              ? 'You have view-only access to this agent'
              : 'Send a message to begin a new session'}
          </p>
        </div>

        {isViewOnly ? (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground border rounded-lg p-6" data-testid="view-only-banner">
            <Eye className="h-5 w-5" />
            <span>Select a session from the sidebar to view its messages</span>
          </div>
        ) : (
          <>
            {!apiKeyConfigured && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <span>No API key configured. An administrator needs to set up the LLM API key.</span>
              </div>
            )}
            {!isRuntimeReady && readiness && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
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
                placeholder="Type a message..."
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
              <p className="mt-2 text-center text-xs text-muted-foreground">
                Press Cmd+Enter to send
              </p>
            </form>
          </>
        )}

        {/* Agent Skills Section — only shown to owners who can manage skills */}
        {isOwner && !isExpanded && skills.length > 0 && (
          <div className="pt-6 border-t">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium text-muted-foreground">
                Agent Skills
              </h2>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-6 w-6 ml-auto"
                onClick={() => refreshSkills.mutate({ agentSlug: agent.slug })}
                disabled={refreshSkills.isPending}
                title="Refresh skills from upstream"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshSkills.isPending ? 'animate-spin' : ''}`} />
              </Button>
            </div>
            <div className="grid gap-2">
              {skills.map((skill) => (
                <AgentSkillCard key={skill.path} skill={skill} agentSlug={agent.slug} />
              ))}
            </div>
          </div>
        )}

        {/* Discover Skills Section — only shown to owners who can install skills */}
        {isOwner && !isExpanded && discoverableSkills.length > 0 && (
          <div className="pt-6 border-t">
            <div className="flex items-center gap-2 mb-3">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <h2 className="text-sm font-medium text-muted-foreground shrink-0">
                Discover Skills
              </h2>
              <div className="ml-auto flex items-center gap-1.5">
                {skillsetList.length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 relative"
                        title="Filter by skillset"
                      >
                        <Filter className="h-3.5 w-3.5 text-muted-foreground" />
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
                <div className="relative w-48">
                  <Input
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    placeholder="Search skills..."
                    className="h-7 text-xs pr-7"
                  />
                  <Search className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                </div>
              </div>
            </div>
            <div className="grid gap-2">
              {pagedSkills.map((skill) => (
                <DiscoverableSkillCard
                  key={`${skill.skillsetId}/${skill.path}`}
                  skill={skill}
                  agentSlug={agent.slug}
                />
              ))}
              {filteredSkills.length === 0 && skillSearch.trim() && (
                <p className="text-xs text-muted-foreground text-center py-3">
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
                  className="h-7 w-7"
                  onClick={() => setSkillPage((p) => p - 1)}
                  disabled={skillPage === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs text-muted-foreground">
                  {skillPage + 1} / {totalPages}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => setSkillPage((p) => p + 1)}
                  disabled={skillPage >= totalPages - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
