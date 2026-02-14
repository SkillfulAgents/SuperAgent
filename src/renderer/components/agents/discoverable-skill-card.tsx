import { useState } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useInstallSkill } from '@renderer/hooks/use-agent-skills'
import { SkillInstallDialog } from './skill-install-dialog'
import type { ApiDiscoverableSkill } from '@shared/lib/types/api'

interface DiscoverableSkillCardProps {
  skill: ApiDiscoverableSkill
  agentSlug: string
}

export function DiscoverableSkillCard({ skill, agentSlug }: DiscoverableSkillCardProps) {
  const installSkill = useInstallSkill()
  const [showInstallDialog, setShowInstallDialog] = useState(false)

  const handleInstall = () => {
    if (skill.requiredEnvVars && skill.requiredEnvVars.length > 0) {
      setShowInstallDialog(true)
    } else {
      installSkill.mutate({
        agentSlug,
        skillsetId: skill.skillsetId,
        skillPath: skill.path,
        skillName: skill.name,
        skillVersion: skill.version,
      })
    }
  }

  const handleInstallWithEnvVars = (envVars: Record<string, string>) => {
    installSkill.mutate({
      agentSlug,
      skillsetId: skill.skillsetId,
      skillPath: skill.path,
      skillName: skill.name,
      skillVersion: skill.version,
      envVars,
    })
    setShowInstallDialog(false)
  }

  return (
    <>
      <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium truncate">{skill.name}</p>
            <span className="text-xs text-muted-foreground">v{skill.version}</span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
            {skill.description}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            From: {skill.skillsetName}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={handleInstall}
          disabled={installSkill.isPending}
          title="Install skill"
        >
          {installSkill.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
        </Button>
      </div>

      {showInstallDialog && skill.requiredEnvVars && (
        <SkillInstallDialog
          open={showInstallDialog}
          onOpenChange={setShowInstallDialog}
          skillName={skill.name}
          requiredEnvVars={skill.requiredEnvVars}
          onInstall={handleInstallWithEnvVars}
        />
      )}
    </>
  )
}
