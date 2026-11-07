import { useState, type ReactElement } from 'react'
import { ArrowDownToLine, LayoutGrid, PenLine } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { ImportAgentDialog } from '@renderer/components/agents/import-agent-dialog'
import { useOpenCreateAgent } from '@renderer/hooks/use-open-create-agent'
import { useCompleteTemplateInstall } from '@renderer/hooks/use-complete-template-install'
import { useFileAgentIntoSection } from '@renderer/hooks/use-file-agent-into-section'
import type { CreateAgentSurface } from '@renderer/router/search-schemas'

interface NewAgentMenuProps {
  /** The button that opens the menu (rendered as its trigger). */
  children: ReactElement
  surface: CreateAgentSurface
  /** A section's +: the new agent is filed into that section. */
  folderId?: string
  /** Called as any option is picked, before it runs (a section's + opens its section). */
  onChoose?: () => void
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
}

/**
 * Every in-app "New Agent" button: a menu of the three ways to make one.
 * From Scratch and Browse Templates open their full-window pages; Import
 * opens the package dialog in place. (The app menu's New Agent cannot show a
 * menu, so it goes straight to From Scratch.)
 */
export function NewAgentMenu({ children, surface, folderId, onChoose, align = 'start', side }: NewAgentMenuProps) {
  const openCreateAgent = useOpenCreateAgent()
  const completeInstall = useCompleteTemplateInstall()
  const fileIntoSection = useFileAgentIntoSection()
  const [importing, setImporting] = useState(false)

  const choose = (run: () => void) => () => {
    onChoose?.()
    run()
  }

  return (
    <>
      {/* Non-modal: inside the mobile sidebar drawer a modal menu would turn
          the opening touch into a tap on the drawer's backdrop (see the
          section menu in agent-folder-block). */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} side={side} className="w-52" data-testid="new-agent-menu">
          <DropdownMenuItem
            onSelect={choose(() => openCreateAgent({ surface, folderId }))}
            data-testid="new-agent-from-scratch"
          >
            <PenLine />
            From Scratch
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={choose(() => openCreateAgent({ surface, folderId, start: 'templates' }))}
            data-testid="new-agent-browse-templates"
          >
            <LayoutGrid />
            Browse Templates
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={choose(() => setImporting(true))}
            data-testid="new-agent-import"
          >
            <ArrowDownToLine />
            Import
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ImportAgentDialog
        open={importing}
        onClose={() => setImporting(false)}
        onComplete={async (agent) => {
          await completeInstall(agent, { source: 'import', surface })
          await fileIntoSection(agent.slug, folderId)
        }}
      />
    </>
  )
}
