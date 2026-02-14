
import { useAgentSkills } from '@renderer/hooks/use-agent-skills'
import { Loader2, Sparkles } from 'lucide-react'
import { AgentSkillCard } from '../agent-skill-card'

interface SkillsTabProps {
  agentSlug: string
}

export function SkillsTab({ agentSlug }: SkillsTabProps) {
  const { data: skills, isLoading } = useAgentSkills(agentSlug)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!skills || skills.length === 0) {
    return (
      <div className="text-center py-8">
        <Sparkles className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">
          No skills have been created yet.
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Skills can be installed from skillsets or created by the agent during conversations.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Skills are reusable capabilities that the agent has learned. They are automatically invoked when relevant.
      </p>

      <div className="grid gap-3">
        {skills.map((skill) => (
          <AgentSkillCard key={skill.path} skill={skill} agentSlug={agentSlug} />
        ))}
      </div>
    </div>
  )
}
