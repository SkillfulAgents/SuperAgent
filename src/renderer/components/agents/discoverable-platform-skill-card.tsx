import { Plus, Loader2, Cloud } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useInstallPlatformSkill } from '@renderer/hooks/use-platform-skills'
import type { PlatformSkillsetIndexSkill } from '@shared/lib/services/platform-skills-service'

interface DiscoverablePlatformSkillCardProps {
  skill: PlatformSkillsetIndexSkill
  skillsetName: string
  agentSlug: string
}

export function DiscoverablePlatformSkillCard({
  skill,
  skillsetName,
  agentSlug,
}: DiscoverablePlatformSkillCardProps) {
  const installSkill = useInstallPlatformSkill()

  const handleInstall = () => {
    installSkill.mutate({
      agentSlug,
      skillsetName,
      skillName: skill.name,
      displayName: skill.name,
    })
  }

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{skill.name}</p>
          <Cloud className="h-3 w-3 text-muted-foreground shrink-0" />
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
          {skill.description}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          From: {skillsetName}
        </p>
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        onClick={handleInstall}
        disabled={installSkill.isPending}
        title="Install skill from platform"
      >
        {installSkill.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
      </Button>
    </div>
  )
}
