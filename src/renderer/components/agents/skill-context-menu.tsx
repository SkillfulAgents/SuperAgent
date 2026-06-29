import { useState } from 'react'
import { FileCode, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { SkillFilesDialog } from './skill-files-dialog'
import { SkillDeleteDialog } from './skill-delete-dialog'
import { useExportSkill } from '@renderer/hooks/use-agent-skills'
import type { ApiSkillWithStatus } from '@shared/lib/types/api'

interface SkillContextMenuProps {
  skill: ApiSkillWithStatus
  agentSlug: string
  children: React.ReactNode
}

export function SkillContextMenu({ skill, agentSlug, children }: SkillContextMenuProps) {
  const [filesDialogOpen, setFilesDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const exportSkill = useExportSkill()
  const skillName = skill.name ?? skill.path

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
                { agentSlug, skillDir: skill.path, skillName },
                { onError: (err) => toast.error('Export failed', { description: err.message }) },
              )
            }}
          >
            <Upload className="h-4 w-4 mr-2" />
            Export Skill
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Skill
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
      <SkillDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
        skillName={skillName}
      />
    </>
  )
}
