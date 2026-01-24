'use client'

import { useAgentSkills } from '@/lib/hooks/use-agent-skills'
import { Loader2, Sparkles } from 'lucide-react'

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
          Skills are created by the agent during conversations.
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
          <div
            key={skill.path}
            className="p-4 rounded-lg border bg-card"
          >
            <div className="flex items-start gap-3">
              <Sparkles className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{skill.name}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {skill.description}
                </p>
                <p className="text-xs text-muted-foreground mt-2 font-mono">
                  .claude/skills/{skill.path}/
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
