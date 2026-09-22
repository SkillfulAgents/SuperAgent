import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Globe, FileText, PanelRightOpen, Workflow } from 'lucide-react'
import { DrawerShell } from './drawer-shell'
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
  /** Wide-screen file previews split the layout by default; Agent Home opts into an overlay. */
  filePreviewWideLayout?: 'split' | 'overlay'
}

export function TrayManager({
  agentSlug,
  sessionId,
  browserActive,
  filePreviewWideLayout = 'split',
}: TrayManagerProps) {
  const filePreview = useFilePreview()
  const hasOpenFiles = filePreview.openTabs.length > 0 && filePreview.isOpen
  const workflow = useWorkflow()
  const hasWorkflow = workflow.openWorkflows.length > 0 && workflow.isOpen
  const [selectedTrayId, setSelectedTrayId] = useState<string>('browser')
  const [isOpen, setIsOpen] = useState(false)
  const [userClosed, setUserClosed] = useState(false)
  // Full screen: the drawer covers the tray host and the sidebar folds away,
  // so the browser gets the whole window. Both come back on exit.
  const [isExpanded, setIsExpanded] = useState(false)
  const sidebarWasOpenRef = useRef(false)
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar()

  // Leaving full screen restores the sidebar. It runs from the button, from
  // Escape, and from every path that takes the drawer away underneath it —
  // hiding the panel, the browser going idle, switching to another tray —
  // otherwise the sidebar stays folded with nothing on screen to unfold it.
  // Tracked in a ref as well as state so exit can read it without going
  // through an updater: a sibling's setState must not run inside one.
  const isExpandedRef = useRef(false)
  const exitFullScreen = useCallback(() => {
    if (!isExpandedRef.current) return
    isExpandedRef.current = false
    setIsExpanded(false)
    if (sidebarWasOpenRef.current) setSidebarOpen(true)
  }, [setSidebarOpen])

  const handleCloseTray = useCallback(() => {
    exitFullScreen()
    setUserClosed(true)
    setIsOpen(false)
  }, [exitFullScreen])

  const handleToggleExpand = useCallback(() => {
    if (isExpanded) {
      exitFullScreen()
    } else {
      sidebarWasOpenRef.current = sidebarOpen
      isExpandedRef.current = true
      setSidebarOpen(false)
      setIsExpanded(true)
    }
  }, [isExpanded, sidebarOpen, setSidebarOpen, exitFullScreen])

  // Canvas input and local dialogs own their handled keys; only an unhandled Escape exits.
  useEffect(() => {
    if (!isExpanded) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      exitFullScreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isExpanded, exitFullScreen])

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
      badge: filePreview.openTabs.length,
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
  ], [browserActive, hasOpenFiles, filePreview.openTabs.length, browserTrayContent, filePreviewTrayContent, hasWorkflow, workflow.openWorkflows.length, workflowTrayContent])

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

  const fileCount = filePreview.openTabs.length
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
      exitFullScreen()
      setIsOpen(false)
      setUserClosed(false)
    }
  }, [anyAvailable, exitFullScreen])

  // Full screen belongs to the browser tray alone: losing it (the browser went
  // idle) or leaving it (the user picked Files or Workflow) ends full screen.
  const activeTrayId = trays.find(t => t.id === selectedTrayId && t.available)?.id ?? availableTrays[0]?.id
  useEffect(() => {
    if (activeTrayId !== 'browser') exitFullScreen()
  }, [activeTrayId, exitFullScreen])

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
      isOpen={isOpen}
      storageKey={DRAWER_STORAGE_KEY}
      responsiveFullWidth={activeTray?.id === 'files'}
      wideOverlay={activeTray?.id === 'files' && filePreviewWideLayout === 'overlay'}
      fullScreen={isExpanded && activeTray?.id === 'browser'}
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
