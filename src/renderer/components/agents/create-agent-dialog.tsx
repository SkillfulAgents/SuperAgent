
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { useState, useRef, useEffect } from 'react'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useSelection } from '@renderer/context/selection-context'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import { useInstallSkill } from '@renderer/hooks/use-agent-skills'
import {
  useDiscoverableAgents,
  useImportAgentTemplate,
  useInstallAgentFromSkillset,
} from '@renderer/hooks/use-agent-templates'
import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2, Upload, FileArchive } from 'lucide-react'
import type { SkillsetIndexSkill } from '@shared/lib/types/skillset'

const ONBOARDING_MESSAGE = 'This agent was just set up from a template. Please run the agent-onboarding skill to help me configure it.'

interface SkillsetSkillsData {
  skillsetId: string
  skillsetName: string
  skills: SkillsetIndexSkill[]
}

function useAllSkillsetSkills() {
  const { data: skillsets } = useSkillsets()

  return useQuery<SkillsetSkillsData[]>({
    queryKey: ['all-skillset-skills', skillsets?.map((s) => s.id)],
    queryFn: async () => {
      if (!skillsets || skillsets.length === 0) return []

      const results: SkillsetSkillsData[] = []
      for (const ss of skillsets) {
        try {
          const res = await apiFetch(`/api/skillsets/${ss.id}/skills`)
          if (res.ok) {
            const data = await res.json()
            results.push({
              skillsetId: ss.id,
              skillsetName: ss.name,
              skills: data.skills,
            })
          }
        } catch {
          // Skip failed skillsets
        }
      }
      return results
    },
    enabled: !!skillsets && skillsets.length > 0,
  })
}

interface CreateAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-select a discoverable agent template (opens "From Skillset" tab) */
  initialTemplate?: { skillsetId: string; name: string; path: string; version: string } | null
}

export function CreateAgentDialog({ open, onOpenChange, initialTemplate }: CreateAgentDialogProps) {
  const [name, setName] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set())
  const [showSkills, setShowSkills] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)
  const [activeTab, setActiveTab] = useState(initialTemplate ? 'skillset' : 'new')
  const createAgent = useCreateAgent()
  const createSession = useCreateSession()
  const { selectAgent, selectSession } = useSelection()
  const { data: skillsetSkills } = useAllSkillsetSkills()
  const installSkill = useInstallSkill()

  // Import tab state
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importName, setImportName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importTemplate = useImportAgentTemplate()

  // From Skillset tab state
  const { data: discoverableAgents } = useDiscoverableAgents()
  const installFromSkillset = useInstallAgentFromSkillset()
  const [selectedTemplate, setSelectedTemplate] = useState<{
    skillsetId: string
    name: string
    path: string
    version: string
  } | null>(null)
  const [skillsetAgentName, setSkillsetAgentName] = useState('')

  // When opened with an initialTemplate, jump to the skillset tab with it pre-selected
  useEffect(() => {
    if (open && initialTemplate) {
      setActiveTab('skillset')
      setSelectedTemplate(initialTemplate)
      setSkillsetAgentName(initialTemplate.name)
    }
  }, [open, initialTemplate])

  const hasSkillsets = skillsetSkills && skillsetSkills.length > 0
  const hasDiscoverableAgents = discoverableAgents && discoverableAgents.length > 0

  const toggleSkill = (key: string) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    try {
      const newAgent = await createAgent.mutateAsync({ name: name.trim() })

      // Install selected skills
      if (selectedSkills.size > 0) {
        setIsInstalling(true)
        for (const key of selectedSkills) {
          const [skillsetId, skillPath] = key.split('::')
          // Find the skill details
          const skillsetData = skillsetSkills?.find((s) => s.skillsetId === skillsetId)
          const skill = skillsetData?.skills.find((s) => s.path === skillPath)
          if (skill) {
            try {
              await installSkill.mutateAsync({
                agentSlug: newAgent.slug,
                skillsetId,
                skillPath,
                skillName: skill.name,
                skillVersion: skill.version,
              })
            } catch (error) {
              console.error(`Failed to install skill ${skill.name}:`, error)
            }
          }
        }
        setIsInstalling(false)
      }

      handleOpenChange(false)
      selectAgent(newAgent.slug)
    } catch (error) {
      console.error('Failed to create agent:', error)
      setIsInstalling(false)
    }
  }

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!importFile) return

    try {
      const result = await importTemplate.mutateAsync({
        file: importFile,
        nameOverride: importName.trim() || undefined,
      })
      handleOpenChange(false)
      selectAgent(result.slug)

      if (result.hasOnboarding) {
        try {
          const session = await createSession.mutateAsync({
            agentSlug: result.slug,
            message: ONBOARDING_MESSAGE,
          })
          selectSession(session.id)
        } catch {
          // Onboarding session creation failed - user can still use agent normally
        }
      }
    } catch (error) {
      console.error('Failed to import template:', error)
    }
  }

  const handleInstallFromSkillset = async () => {
    if (!selectedTemplate || !skillsetAgentName.trim()) return

    try {
      const newAgent = await installFromSkillset.mutateAsync({
        skillsetId: selectedTemplate.skillsetId,
        agentPath: selectedTemplate.path,
        agentName: skillsetAgentName.trim(),
        agentVersion: selectedTemplate.version,
      })
      handleOpenChange(false)
      selectAgent(newAgent.slug)

      if (newAgent.hasOnboarding) {
        try {
          const session = await createSession.mutateAsync({
            agentSlug: newAgent.slug,
            message: ONBOARDING_MESSAGE,
          })
          selectSession(session.id)
        } catch {
          // Onboarding session creation failed - user can still use agent normally
        }
      }
    } catch (error) {
      console.error('Failed to install agent from skillset:', error)
    }
  }

  const isPending = createAgent.isPending || isInstalling

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setName('')
      setSelectedSkills(new Set())
      setShowSkills(false)
      setActiveTab('new')
      setImportFile(null)
      setImportName('')
      setSelectedTemplate(null)
      setSkillsetAgentName('')
      importTemplate.reset()
    }
    onOpenChange(nextOpen)
  }

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file && file.name.endsWith('.zip')) {
      setImportFile(file)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="create-agent-dialog" className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create New Agent</DialogTitle>
          <DialogDescription>
            Create a new AI agent. Each agent runs in its own Docker container.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="w-full">
            <TabsTrigger value="new" className="flex-1">New</TabsTrigger>
            <TabsTrigger value="import" className="flex-1">Import File</TabsTrigger>
            {hasDiscoverableAgents && (
              <TabsTrigger value="skillset" className="flex-1">
                From Skillset ({discoverableAgents!.length})
              </TabsTrigger>
            )}
          </TabsList>

          {/* Tab: New Agent */}
          <TabsContent value="new">
            <form onSubmit={handleSubmit}>
              <div className="py-4 space-y-4">
                <Input
                  placeholder="Agent name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  data-testid="agent-name-input"
                />

                {hasSkillsets && (
                  <div>
                    <button
                      type="button"
                      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowSkills(!showSkills)}
                    >
                      {showSkills ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      Select skills from skillsets
                      {selectedSkills.size > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary ml-1">
                          {selectedSkills.size}
                        </span>
                      )}
                    </button>

                    {showSkills && (
                      <div className="mt-2 space-y-3 max-h-[300px] overflow-y-auto border rounded-lg p-3">
                        {skillsetSkills!.map((ssData) => (
                          <div key={ssData.skillsetId}>
                            <p className="text-xs font-medium text-muted-foreground mb-2">
                              {ssData.skillsetName}
                            </p>
                            <div className="space-y-2">
                              {ssData.skills.map((skill) => {
                                const key = `${ssData.skillsetId}::${skill.path}`
                                return (
                                  <label
                                    key={key}
                                    className="flex items-start gap-2 cursor-pointer"
                                  >
                                    <Checkbox
                                      checked={selectedSkills.has(key)}
                                      onCheckedChange={() => toggleSkill(key)}
                                      className="mt-0.5"
                                    />
                                    <div className="min-w-0">
                                      <p className="text-sm">{skill.name}</p>
                                      <p className="text-xs text-muted-foreground line-clamp-1">
                                        {skill.description}
                                      </p>
                                    </div>
                                  </label>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!name.trim() || isPending} data-testid="create-agent-submit">
                  {isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {isInstalling ? 'Installing skills...' : 'Creating...'}
                    </>
                  ) : (
                    selectedSkills.size > 0
                      ? `Create with ${selectedSkills.size} skill${selectedSkills.size > 1 ? 's' : ''}`
                      : 'Create'
                  )}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>

          {/* Tab: Import File */}
          <TabsContent value="import">
            <form onSubmit={handleImport}>
              <div className="py-4 space-y-4">
                <div
                  className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleFileDrop}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) setImportFile(file)
                    }}
                  />
                  {importFile ? (
                    <div className="flex items-center justify-center gap-2">
                      <FileArchive className="h-5 w-5 text-primary" />
                      <span className="text-sm font-medium">{importFile.name}</span>
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
                    </div>
                  ) : (
                    <>
                      <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">
                        Drop a .zip template file here or click to browse
                      </p>
                    </>
                  )}
                </div>

                <Input
                  placeholder="Name override (optional)"
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                />

                {importTemplate.error && (
                  <p className="text-sm text-destructive">{importTemplate.error.message}</p>
                )}
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!importFile || importTemplate.isPending}>
                  {importTemplate.isPending ? (
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
          </TabsContent>

          {/* Tab: From Skillset */}
          {hasDiscoverableAgents && (
            <TabsContent value="skillset">
              {selectedTemplate ? (
                /* Phase 2: Name the agent */
                <form onSubmit={(e) => { e.preventDefault(); handleInstallFromSkillset() }}>
                  <div className="py-4 space-y-4">
                    <div className="p-3 rounded-lg bg-muted/50">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{selectedTemplate.name}</p>
                        <span className="text-xs text-muted-foreground">v{selectedTemplate.version}</span>
                      </div>
                    </div>

                    <Input
                      placeholder="Agent name"
                      value={skillsetAgentName}
                      onChange={(e) => setSkillsetAgentName(e.target.value)}
                      autoFocus
                    />

                    {installFromSkillset.error && (
                      <p className="text-sm text-destructive">{installFromSkillset.error.message}</p>
                    )}
                  </div>

                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => { setSelectedTemplate(null); setSkillsetAgentName('') }}
                    >
                      Back
                    </Button>
                    <Button type="submit" disabled={!skillsetAgentName.trim() || installFromSkillset.isPending}>
                      {installFromSkillset.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Installing...
                        </>
                      ) : (
                        'Create'
                      )}
                    </Button>
                  </DialogFooter>
                </form>
              ) : (
                /* Phase 1: Pick a template */
                <>
                  <div className="py-4">
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {(() => {
                        const grouped = new Map<string, typeof discoverableAgents>()
                        for (const agent of discoverableAgents!) {
                          const existing = grouped.get(agent.skillsetName) || []
                          existing.push(agent)
                          grouped.set(agent.skillsetName, existing)
                        }

                        return Array.from(grouped.entries()).map(([skillsetName, agents]) => (
                          <div key={skillsetName}>
                            <p className="text-xs font-medium text-muted-foreground mb-2">
                              {skillsetName}
                            </p>
                            <div className="space-y-2">
                              {agents.map((agent) => (
                                <button
                                  key={`${agent.skillsetId}::${agent.path}`}
                                  type="button"
                                  className="w-full text-left p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                                  onClick={() => {
                                    setSelectedTemplate(agent)
                                    setSkillsetAgentName(agent.name)
                                  }}
                                >
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium">{agent.name}</p>
                                    <span className="text-xs text-muted-foreground">v{agent.version}</span>
                                  </div>
                                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                                    {agent.description}
                                  </p>
                                </button>
                              ))}
                            </div>
                          </div>
                        ))
                      })()}
                    </div>
                  </div>

                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => handleOpenChange(false)}
                    >
                      Cancel
                    </Button>
                  </DialogFooter>
                </>
              )}
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
