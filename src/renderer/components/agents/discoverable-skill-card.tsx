import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useInstallSkill } from '@renderer/hooks/use-agent-skills'
import type { ApiDiscoverableSkill } from '@shared/lib/types/api'

interface DiscoverableSkillCardProps {
  skill: ApiDiscoverableSkill
  agentSlug: string
}

export function DiscoverableSkillCard({ skill, agentSlug }: DiscoverableSkillCardProps) {
  const installSkill = useInstallSkill()

  const handleInstall = () => {
    installSkill.mutate({
      agentSlug,
      skillsetId: skill.skillsetId,
      skillPath: skill.path,
      skillName: skill.name,
      skillVersion: skill.version,
    })
  }

  return (
    <div className="rounded-lg border bg-background p-3" data-testid="discoverable-skill-card" data-skill-name={skill.name}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">{skill.name}</div>
          <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
            <span className="text-xs text-muted-foreground truncate">{skill.skillsetName}</span>
            <span className="text-xs text-muted-foreground shrink-0">·</span>
            <span className="text-xs text-muted-foreground shrink-0">v{skill.version}</span>
          </div>
        </div>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="h-7 w-7 shrink-0"
          onClick={handleInstall}
          disabled={installSkill.isPending}
          aria-label={`Install ${skill.name}`}
          title="Install skill"
        >
          {installSkill.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-3 line-clamp-2">
        {skill.description}
      </p>
    </div>
  )
}
