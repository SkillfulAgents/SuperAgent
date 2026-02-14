
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
import { useState } from 'react'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import { useInstallSkill } from '@renderer/hooks/use-agent-skills'
import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { SkillsetIndexSkill } from '@shared/lib/types/skillset'

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
}

export function CreateAgentDialog({ open, onOpenChange }: CreateAgentDialogProps) {
  const [name, setName] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set())
  const [showSkills, setShowSkills] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)
  const createAgent = useCreateAgent()
  const { selectAgent } = useSelection()
  const { data: skillsetSkills } = useAllSkillsetSkills()
  const installSkill = useInstallSkill()

  const hasSkillsets = skillsetSkills && skillsetSkills.length > 0

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

  const isPending = createAgent.isPending || isInstalling

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setName('')
      setSelectedSkills(new Set())
      setShowSkills(false)
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="create-agent-dialog" className="max-h-[80vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create New Agent</DialogTitle>
            <DialogDescription>
              Create a new AI agent. Each agent runs in its own Docker container.
            </DialogDescription>
          </DialogHeader>

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
                    {skillsetSkills.map((ssData) => (
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
      </DialogContent>
    </Dialog>
  )
}
