import { useRef } from 'react'
import { BrowserTabBar } from '@renderer/components/browser/browser-tab-bar'
import { BrowserToolbar } from '@renderer/components/browser/browser-toolbar'
import { BrowserViewport } from '@renderer/components/browser/browser-viewport'
import { useBrowserStream } from '@renderer/hooks/use-browser-stream'

interface MeetingBrowserCardProps {
  agentSlug: string
  sessionId: string
  /** Whether the agent is mid-turn; the viewport glows while it works. */
  isActive: boolean
  width: number
}

/**
 * The agent's browser, live on the meeting camera: the same tab strip, toolbar
 * and screencast canvas as the chat tray, minus the controls nobody in the room
 * can reach. The page runs in the bot's browser, which no person sits at, so
 * the view only follows the agent; it never steers.
 *
 * Mounted only while the session's browser is open. The stream hook clears the
 * session's browser flag when the browser goes away, which unmounts the card.
 */
export function MeetingBrowserCard({ agentSlug, sessionId, isActive, width }: MeetingBrowserCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stream = useBrowserStream({ agentSlug, sessionId, browserActive: true, isConnected: true, isActive, canvasRef })
  // History is authoritative once received; older containers only provide tab URLs.
  const viewingTab = stream.tabs.find((tab) => tab.targetId === stream.viewingTargetId)
  const pageUrl = stream.pageUrl || viewingTab?.url || ''
  return (
    <div className="flex shrink-0 flex-col" style={{ width }} data-testid="meeting-browser">
      <div className="rounded-t-lg bg-muted/60">
        <BrowserTabBar tabs={stream.tabs} viewingTargetId={stream.viewingTargetId} onTabClick={stream.handleTabClick} />
      </div>
      <div className="flex flex-col rounded-b-lg border border-white/10 bg-background shadow-2xl">
        <BrowserToolbar
          url={pageUrl}
          canGoBack={stream.canGoBack}
          canGoForward={stream.canGoForward}
          connected={stream.connected}
          isViewOnly
          loading={stream.pageLoading}
          needsAttention={stream.needsAttention}
          onNavigate={() => {}}
        />
        <BrowserViewport canvasRef={canvasRef} stream={stream} isActive={isActive} isExpanded={false} controls={false} readOnly />
      </div>
    </div>
  )
}
