import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { SquareArrowRight, Gauge, Globe, Maximize2, Minimize2, PanelRight, PanelRightOpen, Plus, SquareTerminal, X } from 'lucide-react'
import { WorkflowIcon } from '@renderer/components/workflow/workflow-icon'
import { DrawerShell } from './drawer-shell'
import { TrayTabs, TrayTabLiveDot, type TrayTab } from './tray-tabs'
import { SubagentsTrayContent } from './subagents-tray-content'
import { TrayEmptyState } from './tray-empty-state'
import { ContextTrayContent } from './context-tray-content'
import { BackgroundTasksTrayContent } from './background-tasks-tray-content'
import { AgentSessionsLiveDot, AgentSessionsTrayContent } from './agent-sessions-tray-content'
import { TRAY_PANEL_CLASS } from './tray-card'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useHeaderTraySlot } from '@renderer/components/layout/content-shell'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { BrowserTrayContent, type BrowserPageActions, type BrowserPages } from '@renderer/components/browser/browser-tray-content'
import { BrowserTabIcon, browserTabLabel } from '@renderer/components/browser/browser-tab-bar'
import { FilePreviewTrayContent } from '@renderer/components/file-preview/file-preview-tray-content'
import { WorkflowTrayContent } from '@renderer/components/workflow/workflow-tray-content'
import { SubagentAvatar } from '@renderer/components/agents/agent-avatar/subagent-avatar'
import { getPreviewTabKey, useFilePreview } from '@renderer/context/file-preview-context'
import { AGENT_SESSIONS_TAB_KEY, BACKGROUND_TAB_KEY, SUBAGENTS_TAB_KEY, useWorkflow, workflowTabKey } from '@renderer/context/workflow-context'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { createSessionMemory } from '@renderer/lib/session-memory'
import { cn } from '@shared/lib/utils/cn'
import { usePendingUserRequests } from '@shared/lib/tools/requests/use-pending-user-requests'

const DRAWER_STORAGE_KEY = 'tray_drawer_width'
/** The browser's tab before its stream has listed any pages. */
const BROWSER_PENDING_KEY = 'browser:pending'
/** The session's context window: what fills it. One per drawer. */
const CONTEXT_TAB_KEY = 'context:usage'
/** A tab + opens: a launcher until something is picked in it, which takes its place. There can be several. */
const NEW_TAB_PREFIX = 'new:'

type TrayDomain = 'browser' | 'files' | 'workflow' | 'agent' | 'context' | 'new'

/** Pages and files each have a selection of their own; a run is its own tab, and subagents share one. */
function domainOf(key: string): TrayDomain {
  if (key.startsWith('browser:')) return 'browser'
  if (key.startsWith('workflow:')) return 'workflow'
  if (key.startsWith('agent:')) return 'agent'
  if (key.startsWith('new:')) return 'new'
  if (key.startsWith('context:')) return 'context'
  return 'files'
}

/**
 * Tabs sit in the order they were opened. Keys already placed keep their
 * place, even while their tab is away (a browser reconnecting), and new ones
 * go to the end. The browser's first pages take the place its placeholder held.
 */
export function placeNewTabs(order: string[], keys: string[]): string[] {
  const placed = new Set(order)
  const added = keys.filter(key => !placed.has(key))
  if (added.length === 0) return order
  const placeholderAt = order.indexOf(BROWSER_PENDING_KEY)
  const pages = added.filter(key => key !== BROWSER_PENDING_KEY && domainOf(key) === 'browser')
  if (placeholderAt >= 0 && pages.length > 0 && !keys.includes(BROWSER_PENDING_KEY)) {
    const others = added.filter(key => !pages.includes(key))
    return [...order.slice(0, placeholderAt), ...pages, ...order.slice(placeholderAt + 1), ...others]
  }
  return [...order, ...added]
}

/** The tab that takes the front when the one there is gone: the next one along, else the one before. */
export function neighbourOf(order: string[], missing: string | null, present: (key: string) => boolean): string | null {
  const at = missing ? order.indexOf(missing) : -1
  if (at >= 0) {
    const after = order.slice(at + 1).find(present)
    if (after) return after
    const before = order.slice(0, at).reverse().find(present)
    if (before) return before
  }
  return [...order].reverse().find(present) ?? null
}

interface TraySnapshot {
  frontKey: string | null
  order: string[]
  hidden: boolean
  browserActive: boolean
}
const trayMemory = createSessionMemory<TraySnapshot>()

/** Lit while the workflow run is still going. */
function WorkflowLiveDot({ sessionId, agentSlug, runId }: { sessionId: string; agentSlug: string; runId: string }) {
  const { workflows } = useMessageStream(sessionId, agentSlug, ['workflows'])
  const run = workflows.find(w => w.runId === runId)
  return run && run.completedAt === undefined ? <TrayTabLiveDot /> : null
}

/** Lit while any subagent of the session is still working. A workflow run is not one: it has a tab of its own. */
function SubagentsLiveDot({ sessionId, agentSlug }: { sessionId: string; agentSlug: string }) {
  const { workflows, activeSubagents, completedSubagents, isActive } = useMessageStream(
    sessionId, agentSlug, ['workflows', 'activeSubagents', 'completedSubagents', 'isActive'],
  )
  const working = isActive && activeSubagents.some(subagent => (
    subagent.status !== 'completed' &&
    !(subagent.parentToolId && completedSubagents?.has(subagent.parentToolId)) &&
    !workflows.some(run => run.toolUseId === subagent.parentToolId)
  ))
  return working ? <TrayTabLiveDot /> : null
}

/** Lit while any background command or monitor of the session is running. */
function BackgroundLiveDot({ sessionId, agentSlug }: { sessionId: string; agentSlug: string }) {
  const { backgroundTasks } = useMessageStream(sessionId, agentSlug, ['backgroundTasks'])
  return backgroundTasks.some(task => !task.isSubagent && !task.isWorkflow) ? <TrayTabLiveDot /> : null
}

/**
 * A subagent that is waiting on the person opens the Subagents tab on its
 * transcript: its question is about work that is otherwise out of sight. Each
 * request does this once, so closing the tab while the request is still open
 * leaves it closed.
 */
function SubagentInputWatcher({ sessionId, agentSlug }: { sessionId: string; agentSlug: string }) {
  const { openSubagent } = useWorkflow()
  const { data: requests } = usePendingUserRequests(agentSlug, sessionId)
  const openedFor = useRef(new Set<string>())
  useEffect(() => {
    for (const request of requests ?? []) {
      const toolCallId = request.parentToolUseId
      if (!toolCallId || !request.blocking || openedFor.current.has(request.id)) continue
      // A request to act in the browser is answered on the page, so the page keeps the front.
      if (request.kind === 'browser_input' || request.kind === 'login') continue
      openedFor.current.add(request.id)
      // The tab finds the call's saved copy in the transcript; this stand-in covers the time before it has one.
      openSubagent({ id: toolCallId, name: 'Agent', input: {} })
    }
  }, [requests, openSubagent])
  return null
}

interface TrayManagerProps {
  agentSlug: string
  sessionId: string
  browserActive: boolean
  /**
   * A session's own drawer: Hide keeps the tabs behind a button, and the tabs
   * are there again when the session is reopened. Off for a home page's
   * preview drawer, where hiding closes it.
   */
  persistent?: boolean
  /** Wide screens split the layout by default; Agent Home opts into an overlay. */
  filePreviewWideLayout?: 'split' | 'overlay'
  /** Draw the drawer at its minimum width while true. */
  narrowDrawer?: boolean
  /** Called as the person drags the drawer's edge. */
  onDrawerResize?: () => void
}

/**
 * The side drawer: one strip of tabs over one body. A tab is a thing to look
 * at (a browser page, a file or folder, a workflow run, the session's subagents),
 * so moving between them never closes the drawer or swaps it for another.
 */
export function TrayManager({
  agentSlug,
  sessionId,
  browserActive,
  persistent = false,
  filePreviewWideLayout = 'split',
  narrowDrawer = false,
  onDrawerResize,
}: TrayManagerProps) {
  const filePreview = useFilePreview()
  const workflow = useWorkflow()
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar()
  // Where the view's header keeps this drawer's toggle (a session's does); null where it has none.
  const headerSlot = useHeaderTraySlot()

  const [pages, setPages] = useState<BrowserPages | null>(null)
  const pageActionsRef = useRef<BrowserPageActions | null>(null)
  const [frontKey, setFrontKey] = useState<string | null>(null)
  const [order, setOrder] = useState<string[]>([])
  const [hidden, setHidden] = useState(false)
  // The card squares off its top-left corner only while the front tab sits
  // directly above it; the strip is the only thing that knows when that is.
  const [leadingTabFlush, setLeadingTabFlush] = useState(false)
  // The Context tab, opened from a New tab.
  const [contextOpen, setContextOpen] = useState(false)
  // New tabs from +, by key, in opening order: each + opens another, as in a browser.
  const [newTabs, setNewTabs] = useState<string[]>([])
  const newTabSeq = useRef(0)
  // Full screen: the drawer covers the tray host and the sidebar folds away,
  // so the tab in front gets the whole window. Both come back on exit.
  const [isExpanded, setIsExpanded] = useState(false)
  const sidebarWasOpenRef = useRef(false)

  // A session's drawer is put back as it was left. The browser coming up
  // normally takes the front; one that was already up when the session was
  // left must not take it again on the way back in.
  const latest = useRef<TraySnapshot>({ frontKey, order, hidden, browserActive })
  useEffect(() => {
    latest.current = { frontKey, order, hidden, browserActive }
  })
  const resumedBrowserRef = useRef(false)
  useEffect(() => {
    const kept = persistent ? trayMemory.get(sessionId) : undefined
    setFrontKey(kept?.frontKey ?? null)
    setOrder(kept?.order ?? [])
    setHidden(kept?.hidden ?? false)
    resumedBrowserRef.current = kept?.browserActive ?? false
    return () => {
      if (persistent) trayMemory.set(sessionId, latest.current)
    }
  }, [sessionId, persistent])

  // Leaving full screen restores the sidebar. It runs from the button, from
  // Escape, and from every path that takes the drawer away underneath it,
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

  const closeFilePreview = filePreview.close

  const forget = useCallback((key: string) => {
    setOrder(current => current.filter(k => k !== key))
  }, [])

  const { openTabs, activeTabIndex, isOpen: filesOpen, setActiveTab, closeTab: closeFileTab } = filePreview
  const { openWorkflows, subagents, closeWorkflow, closeSubagents, background, closeBackgroundTasks, agentSessions, closeAgentSessions } = workflow
  const agentSessionsOpen = agentSessions.open
  // Called agents' names, for their tabs.
  const subagentsOpen = subagents.open
  const backgroundOpen = background.open

  const tabs = useMemo<TrayTab[]>(() => {
    const list: TrayTab[] = []
    if (browserActive) {
      if (pages && pages.tabs.length > 0) {
        for (const page of pages.tabs) {
          const key = `browser:${page.targetId}`
          const label = browserTabLabel(page)
          list.push({
            key,
            kind: 'browser',
            label,
            title: page.title || page.url,
            icon: <BrowserTabIcon faviconUrl={page.faviconUrl} title={label} />,
            // The dot marks the page the agent is on, which cannot be closed out from under it.
            badge: page.active ? <TrayTabLiveDot /> : undefined,
            onSelect: () => {
              pageActionsRef.current?.select(page.targetId)
              setFrontKey(key)
            },
            onClose: page.active ? undefined : () => pageActionsRef.current?.close(page.targetId),
          })
        }
      } else {
        // The browser is up but has not listed its pages yet.
        list.push({
          key: BROWSER_PENDING_KEY,
          kind: 'browser',
          label: 'Browser',
          icon: <Globe className="h-3.5 w-3.5 text-inherit" />,
          onSelect: () => setFrontKey(BROWSER_PENDING_KEY),
        })
      }
    }
    if (filesOpen) {
      openTabs.forEach((tab, index) => {
        const key = getPreviewTabKey(tab)
        const path = tab.kind === 'file' ? tab.filePath : tab.rootPath
        list.push({
          key,
          kind: 'file',
          label: tab.displayName,
          title: path,
          icon: (
            // Follow the tab's own color so the icon darkens with the label on the
            // front tab and on hover, instead of the icon's muted default.
            <FileTypeIcon filename={tab.displayName} size="sm" folder={tab.kind === 'folder'} className="text-inherit" />
          ),
          onSelect: () => {
            setActiveTab(index)
            setFrontKey(key)
          },
          onClose: tab.kind === 'folder' && tab.closable === false ? undefined : () => {
            closeFileTab(key)
            forget(key)
          },
          data: { 'data-tab-kind': tab.kind, 'data-file-name': tab.displayName, 'data-path': path },
        })
      })
    }
    for (const run of openWorkflows) {
      const key = workflowTabKey(run.runId)
      list.push({
        key,
        kind: 'workflow',
        label: run.name ?? 'Workflow',
        icon: <WorkflowIcon className="h-3.5 w-3.5 text-inherit" />,
        badge: <WorkflowLiveDot sessionId={sessionId} agentSlug={agentSlug} runId={run.runId} />,
        onSelect: () => setFrontKey(key),
        onClose: () => {
          closeWorkflow(run.runId)
          forget(key)
        },
      })
    }
    if (subagentsOpen) {
      // One tab for every subagent: its list drills into each of them.
      list.push({
        key: SUBAGENTS_TAB_KEY,
        kind: 'agent',
        label: 'Subagents',
        icon: <SubagentAvatar size={14} />,
        badge: <SubagentsLiveDot sessionId={sessionId} agentSlug={agentSlug} />,
        onSelect: () => setFrontKey(SUBAGENTS_TAB_KEY),
        onClose: () => {
          closeSubagents()
          forget(SUBAGENTS_TAB_KEY)
        },
      })
    }
    if (agentSessionsOpen) {
      // One tab for every session this one called: its list drills into each conversation, as Subagents does.
      list.push({
        key: AGENT_SESSIONS_TAB_KEY,
        kind: 'call',
        label: 'Invoked agents',
        icon: <SquareArrowRight className="h-3.5 w-3.5 text-inherit" />,
        badge: <AgentSessionsLiveDot sessionId={sessionId} agentSlug={agentSlug} />,
        onSelect: () => setFrontKey(AGENT_SESSIONS_TAB_KEY),
        onClose: () => {
          closeAgentSessions()
          forget(AGENT_SESSIONS_TAB_KEY)
        },
      })
    }
    if (backgroundOpen) {
      list.push({
        key: BACKGROUND_TAB_KEY,
        kind: 'background',
        label: 'Background tasks',
        icon: <SquareTerminal className="h-3.5 w-3.5 text-inherit" />,
        badge: <BackgroundLiveDot sessionId={sessionId} agentSlug={agentSlug} />,
        onSelect: () => setFrontKey(BACKGROUND_TAB_KEY),
        onClose: () => {
          closeBackgroundTasks()
          forget(BACKGROUND_TAB_KEY)
        },
      })
    }
    if (contextOpen) {
      list.push({
        key: CONTEXT_TAB_KEY,
        kind: 'context',
        label: 'Context',
        icon: <Gauge className="h-3.5 w-3.5 text-inherit" />,
        onSelect: () => setFrontKey(CONTEXT_TAB_KEY),
        onClose: () => {
          setContextOpen(false)
          forget(CONTEXT_TAB_KEY)
        },
      })
    }
    for (const key of newTabs) {
      list.push({
        key,
        kind: 'new',
        label: 'New tab',
        icon: <Plus className="h-3.5 w-3.5 text-inherit" />,
        onSelect: () => setFrontKey(key),
        onClose: () => {
          setNewTabs(current => current.filter(k => k !== key))
          forget(key)
        },
      })
    }
    return list
  }, [browserActive, pages, filesOpen, openTabs, openWorkflows, subagentsOpen, agentSessionsOpen, backgroundOpen, contextOpen, newTabs, sessionId, agentSlug, setActiveTab, closeFileTab, closeWorkflow, closeSubagents, closeBackgroundTasks, closeAgentSessions, forget])

  const openNewTab = () => {
    newTabSeq.current += 1
    const key = `${NEW_TAB_PREFIX}${newTabSeq.current}`
    setNewTabs(current => [...current, key])
    setFrontKey(key)
    setHidden(false)
  }
  const openContext = () => {
    setContextOpen(true)
    setFrontKey(CONTEXT_TAB_KEY)
    setHidden(false)
  }
  // Picking something in a New tab opens it in its own tab, and that New tab goes; the others stay.
  const pickFromNewTab = (key: string, open: () => void) => {
    setNewTabs(current => current.filter(k => k !== key))
    forget(key)
    open()
  }

  // Put the tabs in opening order. A new key is placed during this render, so
  // the strip never draws a tab out of place for a frame.
  const byKey = new Map(tabs.map(tab => [tab.key, tab]))
  const placed = placeNewTabs(order, tabs.map(tab => tab.key))
  if (placed !== order) setOrder(placed)
  const orderedTabs = placed.flatMap(key => byKey.get(key) ?? [])

  // Which tab is in front. Pages and files keep their own selection (the page
  // being viewed, the active file), so a front key in either of those domains
  // means "whichever one that domain has selected now".
  const viewedPage = pages?.viewingTargetId ?? pages?.tabs.find(page => page.active)?.targetId ?? pages?.tabs[0]?.targetId
  const browserKey = !browserActive ? null : viewedPage ? `browser:${viewedPage}` : BROWSER_PENDING_KEY
  const activeFile = filesOpen ? openTabs[activeTabIndex] : undefined
  const fileKey = activeFile ? getPreviewTabKey(activeFile) : null
  const resolve = (key: string | null): string | null => {
    if (!key) return null
    const domain = domainOf(key)
    const resolved = domain === 'browser' ? browserKey : domain === 'files' ? fileKey : key
    return resolved && byKey.has(resolved) ? resolved : null
  }
  const front = resolve(frontKey) ?? resolve(neighbourOf(placed, frontKey, key => byKey.has(key)))
  if (front !== frontKey && tabs.length > 0) setFrontKey(front)
  const frontTab = front ? byKey.get(front) : undefined

  // Opening a file, a run or an agent brings its tab to the front, and brings
  // the drawer back if it was hidden.
  const fileFocus = filePreview.focus
  useEffect(() => {
    if (!fileFocus) return
    setFrontKey(fileFocus.key)
    setHidden(false)
  }, [fileFocus])
  const workflowFocus = workflow.focus
  useEffect(() => {
    if (!workflowFocus) return
    setFrontKey(workflowFocus.key)
    setHidden(false)
  }, [workflowFocus])

  // The browser coming up takes the front, unless the drawer was hidden by hand.
  const hiddenRef = useRef(hidden)
  useEffect(() => {
    hiddenRef.current = hidden
  })
  useEffect(() => {
    if (!browserActive) return
    if (resumedBrowserRef.current) {
      resumedBrowserRef.current = false
      return
    }
    if (!hiddenRef.current) setFrontKey(BROWSER_PENDING_KEY)
  }, [browserActive])

  // With nothing left to show there is nothing to hide or to fill the screen with.
  const isEmpty = tabs.length === 0
  useEffect(() => {
    if (!isEmpty) return
    exitFullScreen()
    setHidden(false)
  }, [isEmpty, exitFullScreen])

  const handleHide = () => {
    exitFullScreen()
    // A preview drawer has nothing to come back to: hiding it closes it.
    if (persistent) setHidden(true)
    else closeFilePreview()
  }

  // With no tabs there is no drawer: opening it from the header opens a New tab, and closing its last tab closes it.
  const drawerShown = !isEmpty && !hidden

  // The drawer mounts closed and opens on the next frame, so its width animates in.
  const wantOpen = drawerShown
  const [isOpen, setIsOpen] = useState(false)
  useEffect(() => {
    if (!wantOpen) {
      setIsOpen(false)
      return
    }
    const frame = requestAnimationFrame(() => setIsOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [wantOpen])

  const inputWatcher = persistent ? <SubagentInputWatcher sessionId={sessionId} agentSlug={agentSlug} /> : null
  if (isEmpty && !headerSlot) return inputWatcher

  const frontRun = frontTab?.kind === 'workflow' ? openWorkflows.find(run => workflowTabKey(run.runId) === frontTab.key) : undefined

  return (
    <>
      {inputWatcher}
      {headerSlot && createPortal(
        // The drawer's one toggle, always in the header: lit while the drawer is open. Hidden
        // tabs are named in its label for screen readers only; the button shows just the icon.
        <button
          type="button"
          onClick={() => {
            if (drawerShown) handleHide()
            else if (isEmpty) openNewTab()
            else setHidden(false)
          }}
          className={cn(
            'flex h-[30px] items-center gap-1 rounded-[calc(var(--radius-icon)+1px)] px-2 transition-colors hover:bg-muted hover:text-foreground',
            drawerShown ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          title={drawerShown ? 'Hide panel' : 'Show panel'}
          aria-label={
            drawerShown ? 'Hide panel'
              : isEmpty ? 'Show panel'
                : `Show panel, ${orderedTabs.length} ${orderedTabs.length === 1 ? 'tab' : 'tabs'}`
          }
          aria-pressed={drawerShown}
          data-testid={drawerShown ? 'tray-hide' : 'tray-show'}
        >
          <PanelRight className="h-4 w-4" />
        </button>,
        headerSlot,
      )}
      {!headerSlot && hidden && (
        <div className="h-full flex items-start pt-2 pr-1 shrink-0">
          <button
            type="button"
            onClick={() => setHidden(false)}
            className="flex items-center gap-1 p-1.5 rounded-item hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            title="Show panel"
            aria-label={`Show panel, ${orderedTabs.length} ${orderedTabs.length === 1 ? 'tab' : 'tabs'}`}
            data-testid="tray-show"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        </div>
      )}
      {!isEmpty && <DrawerShell
        isOpen={isOpen}
        storageKey={DRAWER_STORAGE_KEY}
        responsiveFullWidth
        floating
        wideOverlay={filePreviewWideLayout === 'overlay'}
        fullScreen={isExpanded}
        narrow={narrowDrawer}
        onResize={onDrawerResize}
        // Hidden, the drawer stays mounted so the browser keeps its pages and
        // log, but takes no space, focus or clicks.
        className={hidden ? 'hidden' : undefined}
      >
        {/* 8px in from the drawer's sides and bottom: the tabs standing on the page, Chrome-style, and under them
            one card holding the front tab's body, which the front tab joins. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-2 pb-2">
        <TrayTabs
          tabs={orderedTabs}
          frontKey={front}
          onLeadingTabFlush={setLeadingTabFlush}
          afterTabs={
            <button
              type="button"
              className="inline-flex p-0.5 rounded-icon hover:bg-muted transition-colors"
              onClick={openNewTab}
              title="New tab"
              aria-label="New tab"
              data-testid="tray-new-tab"
            >
              <Plus className="h-4 w-4" />
            </button>
          }
          trailing={
            // The drawer's own controls, the same for every tab. Compact layouts
            // already fill their host: they drop full screen and show a close
            // button in place of hide (see globals.css). Where the header has the
            // toggle, the wide hide button here would only repeat it.
            <div className="flex items-center gap-1" data-testid="tray-controls">
              <button
                type="button"
                className="tray-wide-only inline-flex p-0.5 rounded-icon hover:bg-muted transition-colors"
                onClick={handleToggleExpand}
                title={isExpanded ? 'Exit full screen' : 'Full screen'}
                aria-label={isExpanded ? 'Exit full screen' : 'Full screen'}
                aria-pressed={isExpanded}
                data-testid="tray-fullscreen"
              >
                {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              <button
                type="button"
                className="file-preview-compact-close hidden p-0.5 rounded-icon hover:bg-muted transition-colors"
                onClick={handleHide}
                title="Close panel"
                aria-label="Close panel"
              >
                <X className="h-4 w-4" />
              </button>
              {!headerSlot && (
                <button
                  type="button"
                  className="file-preview-wide-close inline-flex p-0.5 rounded-icon hover:bg-muted transition-colors"
                  onClick={handleHide}
                  title="Hide panel"
                  aria-label="Hide panel"
                  data-testid="tray-hide"
                >
                  <PanelRight className="h-4 w-4" />
                </button>
              )}
            </div>
          }
        />
        <div className={cn(TRAY_PANEL_CLASS, leadingTabFlush && 'rounded-tl-none')} data-testid="tray-panel">
        <div className="flex flex-1 flex-col min-w-0 min-h-0">
          {/* The browser stays mounted behind other tabs: its stream, its pages
              and its log would otherwise start over on every visit. */}
          {browserActive && (
            <BrowserTrayContent
              agentSlug={agentSlug}
              sessionId={sessionId}
              visible={frontTab?.kind === 'browser'}
              connected={!hidden}
              isExpanded={isExpanded}
              onPagesChange={setPages}
              actionsRef={pageActionsRef}
            />
          )}
          {!hidden && frontTab?.kind === 'file' && (
            <FilePreviewTrayContent sessionId={sessionId} />
          )}
          {!hidden && frontRun && (
            <WorkflowTrayContent
              key={frontRun.runId}
              agentSlug={agentSlug}
              sessionId={sessionId}
              runId={frontRun.runId}
              agentId={frontRun.agentId}
              fallbackName={frontRun.name}
            />
          )}
          {!hidden && frontTab?.key === SUBAGENTS_TAB_KEY && (
            <SubagentsTrayContent agentSlug={agentSlug} sessionId={sessionId} />
          )}
          {!hidden && frontTab?.kind === 'new' && (
            <TrayEmptyState
              key={frontTab.key}
              agentSlug={agentSlug}
              sessionId={sessionId}
              onOpenFile={(filePath, description) => pickFromNewTab(frontTab.key, () => filePreview.openFile(filePath, agentSlug, description))}
              onOpenSubagents={() => pickFromNewTab(frontTab.key, workflow.openSubagents)}
              onOpenContext={() => pickFromNewTab(frontTab.key, openContext)}
              onOpenBackground={() => pickFromNewTab(frontTab.key, workflow.openBackgroundTasks)}
              onOpenAgentSessions={() => pickFromNewTab(frontTab.key, workflow.openAgentSessions)}
            />
          )}
          {!hidden && frontTab?.key === AGENT_SESSIONS_TAB_KEY && (
            <AgentSessionsTrayContent agentSlug={agentSlug} sessionId={sessionId} />
          )}
          {!hidden && frontTab?.key === BACKGROUND_TAB_KEY && (
            <BackgroundTasksTrayContent agentSlug={agentSlug} sessionId={sessionId} />
          )}
          {!hidden && frontTab?.key === CONTEXT_TAB_KEY && (
            <ContextTrayContent agentSlug={agentSlug} sessionId={sessionId} />
          )}
        </div>
        </div>
        </div>
      </DrawerShell>}
    </>
  )
}
