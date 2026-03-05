
import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Send, Loader2, Sparkles, Paperclip, Search, RefreshCw, ChevronLeft, ChevronRight, Filter, Eye, Maximize2, Minimize2, Mic, MicOff } from 'lucide-react'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useSettings } from '@renderer/hooks/use-settings'
import { useDialogs } from '@renderer/context/dialog-context'
import { useVoiceInput } from '@renderer/hooks/use-voice-input'
import { useAgentSkills, useDiscoverableSkills, useRefreshAgentSkills } from '@renderer/hooks/use-agent-skills'
import { AgentSkillCard } from './agent-skill-card'
import { DiscoverableSkillCard } from './discoverable-skill-card'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { AttachmentPreview, type Attachment } from '@renderer/components/messages/attachment-preview'
import type { ApiAgent } from '@renderer/hooks/use-agents'

interface AgentLandingProps {
  agent: ApiAgent
  onSessionCreated: (sessionId: string, initialMessage: string) => void
}

export function AgentLanding({ agent, onSessionCreated }: AgentLandingProps) {
  const { canUseAgent, canAdminAgent } = useUser()
  const isViewOnly = !canUseAgent(agent.slug)
  const isOwner = canAdminAgent(agent.slug)
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false)
  const [skillSearch, setSkillSearch] = useState('')
  const [skillPage, setSkillPage] = useState(0)
  const [selectedSkillsets, setSelectedSkillsets] = useState<Set<string> | null>(null)
  const SKILLS_PER_PAGE = 6
  const fileInputRef = useRef<HTMLInputElement>(null)
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

  const addFiles = useCallback((files: FileList | File[]) => {
    const newAttachments: Attachment[] = Array.from(files).map((file) => {
      const attachment: Attachment = {
        file,
        id: crypto.randomUUID(),
      }
      if (file.type.startsWith('image/')) {
        attachment.preview = URL.createObjectURL(file)
      }
      return attachment
    })
    setAttachments((prev) => [...prev, ...newAttachments])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id)
      if (removed?.preview) {
        URL.revokeObjectURL(removed.preview)
      }
      return prev.filter((a) => a.id !== id)
    })
  }, [])

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      attachments.forEach((a) => {
        if (a.preview) URL.revokeObjectURL(a.preview)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-expand when message gets long (5+ lines)
  useEffect(() => {
    const lineCount = message.split('\n').length
    if (lineCount >= 5 && !isExpanded && !manuallyCollapsed) {
      setIsExpanded(true)
    }
  }, [message, isExpanded, manuallyCollapsed])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const hasContent = message.trim() || attachments.length > 0
    if (!hasContent || createSession.isPending || isUploading) return

    try {
      let content = message.trim()

      // Upload attachments first (using agent-level endpoint, no session needed)
      if (attachments.length > 0) {
        setIsUploading(true)
        try {
          const uploadResults = await Promise.all(
            attachments.map(async (a) => {
              const formData = new FormData()
              formData.append('file', a.file)
              const res = await apiFetch(
                `/api/agents/${agent.slug}/upload-file`,
                { method: 'POST', body: formData }
              )
              if (!res.ok) throw new Error('Failed to upload file')
              return res.json() as Promise<{ path: string; filename: string; size: number }>
            })
          )

          const filePaths = uploadResults.map((r) => `- ${r.path}`).join('\n')
          if (content) {
            content = `${content}\n\n[Attached files:]\n${filePaths}`
          } else {
            content = `[Attached files:]\n${filePaths}`
          }
        } catch (error) {
          console.error('Failed to upload attachments:', error)
          setIsUploading(false)
          return
        }
        setIsUploading(false)
      }

      // Stop voice recording if active
      if (voiceInput.isRecording || voiceInput.isConnecting) {
        voiceInput.stopRecording()
      }

      // Create session with the message (including file paths)
      const session = await createSession.mutateAsync({
        agentSlug: agent.slug,
        message: content,
      })

      setMessage('')
      attachments.forEach((a) => {
        if (a.preview) URL.revokeObjectURL(a.preview)
      })
      setAttachments([])
      onSessionCreated(session.id, content)
    } catch (error) {
      console.error('Failed to start session:', error)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files)
      e.target.value = ''
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

  const { data: settingsData } = useSettings()
  const { openSettings } = useDialogs()

  const hasVoiceConfigured = settingsData?.voice?.sttProvider && (
    (settingsData.voice.sttProvider === 'deepgram' && settingsData.apiKeyStatus?.deepgram?.isConfigured) ||
    (settingsData.voice.sttProvider === 'openai' && settingsData.apiKeyStatus?.openai?.isConfigured)
  )

  const voiceInput = useVoiceInput({
    onTranscriptUpdate: useCallback((text: string) => {
      setMessage(text)
    }, []),
    agentSlug: agent.slug,
  })

  const handleVoiceToggle = useCallback(() => {
    if (!hasVoiceConfigured) {
      openSettings('voice')
      return
    }
    if (voiceInput.isRecording || voiceInput.isConnecting) {
      voiceInput.stopRecording()
    } else {
      voiceInput.startRecording(message)
    }
  }, [hasVoiceConfigured, openSettings, voiceInput, message])

  const isDisabled = createSession.isPending || isUploading || !isRuntimeReady

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

            <form
              onSubmit={handleSubmit}
              className={`space-y-4 ${isDragOver ? 'ring-2 ring-primary rounded-lg' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="relative">
                <Textarea
                  placeholder="Type your message..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className={`pr-12 resize-none text-base transition-[min-height] duration-300 ease-in-out ${isExpanded ? 'min-h-[50vh]' : 'min-h-[120px]'}`}
                  disabled={isDisabled}
                  autoFocus
                  data-testid="landing-message-input"
                />
                <div className="absolute bottom-3 right-3 flex gap-1">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => {
                      setIsExpanded((v) => {
                        if (v) setManuallyCollapsed(true)
                        else setManuallyCollapsed(false)
                        return !v
                      })
                    }}
                    title={isExpanded ? 'Collapse input' : 'Expand input'}
                  >
                    {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isDisabled}
                    title="Attach file"
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                  {voiceInput.isSupported && (
                    <Button
                      type="button"
                      size="icon"
                      variant={voiceInput.isRecording ? 'destructive' : 'ghost'}
                      className={`h-8 w-8 ${voiceInput.isRecording ? 'animate-pulse' : ''}`}
                      onClick={handleVoiceToggle}
                      disabled={isDisabled && !voiceInput.isRecording}
                      title={
                        !hasVoiceConfigured
                          ? 'Set up voice input'
                          : voiceInput.isRecording
                            ? 'Stop recording'
                            : 'Voice input'
                      }
                    >
                      {voiceInput.isConnecting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : voiceInput.isRecording ? (
                        <MicOff className="h-4 w-4" />
                      ) : (
                        <Mic className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                  <Button
                    type="submit"
                    size="icon"
                    className="h-8 w-8"
                    disabled={(!message.trim() && attachments.length === 0) || isDisabled}
                    data-testid="landing-send-button"
                  >
                    {isDisabled ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
              <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />
              <p className="text-xs text-muted-foreground text-center">
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
