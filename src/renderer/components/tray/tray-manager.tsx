import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Globe, FileText, PanelRightOpen, Workflow } from 'lucide-react'
import { DrawerShell, type DrawerShellHandle } from './drawer-shell'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { TrayTabStrip, type TrayDef } from './tray-tab-strip'
import { BrowserTrayContent } from '@renderer/components/browser/browser-tray-content'
import { FilePreviewTrayContent } from '@renderer/components/file-preview/file-preview-tray-content'
import { WorkflowTrayContent } from '@renderer/components/workflow/workflow-tray-content'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { useWorkflow } from '@renderer/context/workflow-context'

const DRAWER_STORAGE_KEY = 'tray_drawer_width'

interface TrayManagerProps {
  agentSlug: string
  sessionId: string
  browserActive: boolean
}

export function TrayManager({ agentSlug, sessionId, browserActive }: TrayManagerProps) {
  const filePreview = useFilePreview()
  const hasOpenFiles = filePreview.openFiles.length > 0 && filePreview.isOpen
  const workflow = useWorkflow()
  const hasWorkflow = workflow.openWorkflows.length > 0 && workflow.isOpen
  const [selectedTrayId, setSelectedTrayId] = useState<string>('browser')
  const [isOpen, setIsOpen] = useState(false)
  const [userClosed, setUserClosed] = useState(false)
  const drawerRef = useRef<DrawerShellHandle>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const preExpandWidthRef = useRef<number | null>(null)
  const sidebarWasOpenRef = useRef(false)
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar()

  const handleCloseTray = useCallback(() => {
    setUserClosed(true)
    setIsOpen(false)
  }, [])

  const handleToggleExpand = useCallback(() => {
    if (isExpanded) {
      if (preExpandWidthRef.current != null && drawerRef.current) {
        drawerRef.current.setWidth(preExpandWidthRef.current)
      }
      if (sidebarWasOpenRef.current) setSidebarOpen(true)
      setIsExpanded(false)
    } else {
      preExpandWidthRef.current = drawerRef.current?.getWidth() ?? null
      sidebarWasOpenRef.current = sidebarOpen
      drawerRef.current?.setWidth(800)
      setSidebarOpen(false)
      setIsExpanded(true)
    }
  }, [isExpanded, sidebarOpen, setSidebarOpen])

  const browserTrayContent = useMemo(() => (
    <BrowserTrayContent
      agentSlug={agentSlug}
      sessionId={sessionId}
      onClose={handleCloseTray}
      isExpanded={isExpanded}
      onToggleExpand={handleToggleExpand}
    />
  ), [agentSlug, sessionId, handleCloseTray, isExpanded, handleToggleExpand])

  const closeFilePreview = filePreview.close
  const handleCloseFilePreview = useCallback(() => closeFilePreview(), [closeFilePreview])

  const filePreviewTrayContent = useMemo(() => (
    <FilePreviewTrayContent
      sessionId={sessionId}
      onClose={handleCloseFilePreview}
    />
  ), [sessionId, handleCloseFilePreview])

  const closeWorkflow = workflow.close
  const handleCloseWorkflow = useCallback(() => closeWorkflow(), [closeWorkflow])

  const workflowTrayContent = useMemo(() => (
    <WorkflowTrayContent
      agentSlug={agentSlug}
      sessionId={sessionId}
      onClose={handleCloseWorkflow}
    />
  ), [agentSlug, sessionId, handleCloseWorkflow])

  const trays: TrayDef[] = useMemo(() => [
    {
      id: 'browser',
      icon: Globe,
      label: 'Browser',
      available: browserActive,
      content: browserTrayContent,
    },
    {
      id: 'files',
      icon: FileText,
      label: 'Files',
      available: hasOpenFiles,
      badge: filePreview.openFiles.length,
      content: filePreviewTrayContent,
    },
    {
      id: 'workflow',
      icon: Workflow,
      label: 'Workflow',
      available: hasWorkflow,
      badge: workflow.openWorkflows.length,
      content: workflowTrayContent,
    },
  ], [browserActive, hasOpenFiles, filePreview.openFiles.length, browserTrayContent, filePreviewTrayContent, hasWorkflow, workflow.openWorkflows.length, workflowTrayContent])

  const availableTrays = trays.filter(t => t.available)
  const anyAvailable = availableTrays.length > 0

  // Auto-open when a tray becomes available
  useEffect(() => {
    if (browserActive && !userClosed) {
      requestAnimationFrame(() => {
        setIsOpen(true)
        setSelectedTrayId('browser')
      })
    }
  }, [browserActive, userClosed])

  const fileCount = filePreview.openFiles.length
  useEffect(() => {
    if (hasOpenFiles && !userClosed) {
      requestAnimationFrame(() => {
        setIsOpen(true)
        setSelectedTrayId('files')
      })
    }
  }, [hasOpenFiles, fileCount, userClosed])

  // Open the drawer to the workflow tray when a run is opened (e.g. via the inline
  // block). Re-fire on selection changes so opening a second run re-focuses it.
  const selectedRunId = workflow.selectedRunId
  useEffect(() => {
    if (hasWorkflow) {
      requestAnimationFrame(() => {
        setIsOpen(true)
        setUserClosed(false)
        setSelectedTrayId('workflow')
      })
    }
  }, [hasWorkflow, selectedRunId])

  // Close when no trays are available
  useEffect(() => {
    if (!anyAvailable) {
      setIsOpen(false)
      setUserClosed(false)
    }
  }, [anyAvailable])

  // Switch away from unavailable tray
  useEffect(() => {
    const selected = trays.find(t => t.id === selectedTrayId)
    if (!selected?.available && availableTrays.length > 0) {
      setSelectedTrayId(availableTrays[0].id)
    }
  }, [trays, selectedTrayId, availableTrays])

  if (!anyAvailable) return null

  if (userClosed && !isOpen) {
    return (
      <div className="h-full flex items-start pt-2 pr-1 shrink-0">
        <button
          onClick={() => {
            setUserClosed(false)
            requestAnimationFrame(() => setIsOpen(true))
          }}
          className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          title="Show panel"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </div>
    )
  }

  const activeTray = trays.find(t => t.id === selectedTrayId && t.available) || availableTrays[0]

  return (
    <DrawerShell
      ref={drawerRef}
      isOpen={isOpen}
      storageKey={DRAWER_STORAGE_KEY}
    >
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {activeTray?.content}
        </div>
        {availableTrays.length >= 2 && (
          <TrayTabStrip
            trays={trays}
            selectedTrayId={activeTray?.id || ''}
            onSelect={setSelectedTrayId}
          />
        )}
      </div>
    </DrawerShell>
  )
}
