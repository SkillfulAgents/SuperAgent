import { useState } from 'react'
import { FileCode, Upload } from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { SkillFilesDialog } from './skill-files-dialog'
import { useExportSkill } from '@renderer/hooks/use-agent-skills'
import type { ApiSkillWithStatus } from '@shared/lib/types/api'

interface SkillContextMenuProps {
  skill: ApiSkillWithStatus
  agentSlug: string
  children: React.ReactNode
}

export function SkillContextMenu({ skill, agentSlug, children }: SkillContextMenuProps) {
  const [filesDialogOpen, setFilesDialogOpen] = useState(false)
  const exportSkill = useExportSkill()

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setFilesDialogOpen(true)}>
            <FileCode className="h-4 w-4 mr-2" />
            View Files
          </ContextMenuItem>
          <ContextMenuItem
            disabled={exportSkill.isPending}
            onClick={() => {
              exportSkill.mutate(
                { agentSlug, skillDir: skill.path, skillName: skill.name ?? skill.path },
                { onError: (err) => toast.error('Export failed', { description: err.message }) },
              )
            }}
          >
            <Upload className="h-4 w-4 mr-2" />
            Export Skill
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <SkillFilesDialog
        open={filesDialogOpen}
        onOpenChange={setFilesDialogOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
        skillName={skill.name}
      />
    </>
  )
}
