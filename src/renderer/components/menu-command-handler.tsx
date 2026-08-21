import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useDialogs } from '../context/dialog-context'
import { useCreateUntitledAgent } from '../hooks/use-create-untitled-agent'

/**
 * A command from the native application menu / tray / deep links. The
 * navigate-to-agent channel also carries an optional sessionId (live deep
 * links); menu items and window-closed replays only supply the agent slug.
 */
type MenuCommand =
  | { channel: 'navigate-to-agent'; agentSlug: string; sessionId?: string | null }
  | { channel: 'open-settings' }
  | { channel: 'open-create-agent' }

/**
 * Single source of truth for what each menu command DOES in the renderer. Both
 * the live IPC events (window already open) and the commands replayed after the
 * window is recreated (queued in the main process while it was closed — SUP-264)
 * route through here, so the mapping lives in one place.
 *
 * Post router-migration the dispatch navigates the router directly (replacing the
 * old SelectionContext.setAgent) and opens global settings via its /settings
 * route through useDialogs().openSettings (replacing the old setSettingsOpen).
 */
function useMenuCommandDispatch(): (command: MenuCommand) => void {
  const navigate = useNavigate()
  const { openSettings } = useDialogs()
  const { createUntitledAgent } = useCreateUntitledAgent()

  return useCallback(
    (command: MenuCommand) => {
      switch (command.channel) {
        case 'navigate-to-agent':
          if (command.sessionId) {
            void navigate({
              to: '/agents/$slug/sessions/$sessionId',
              params: { slug: command.agentSlug, sessionId: command.sessionId },
            })
          } else {
            void navigate({ to: '/agents/$slug', params: { slug: command.agentSlug } })
          }
          break
        case 'open-settings':
          openSettings()
          break
        case 'open-create-agent':
          void createUntitledAgent()
          break
      }
    },
    [navigate, openSettings, createUntitledAgent],
  )
}

/**
 * Routes native application-menu commands (Agents > <name>, Settings, New Agent)
 * into the router. Owns BOTH the live IPC subscriptions and the mount-time flush
 * of commands that fired while the window was closed (SUP-264), dispatching every
 * one through useMenuCommandDispatch. Mounted in RootLayout — inside the
 * RouterProvider (useNavigate) and DialogProvider (openSettings) — so it survives
 * the shell⇄settings route switch. Replaces the pre-merge scattered subscriptions
 * (TrayNavigationHandler / dialog-context onOpenSettings / app-sidebar
 * onOpenCreateAgent), keeping the menu→action mapping in one place.
 */
export function MenuCommandHandler() {
  const dispatch = useMenuCommandDispatch()

  // Live events — the window is already open and listening.
  useEffect(() => {
    const api = window.electronAPI
    if (!api) return
    const unsubscribers = [
      api.onNavigateToAgent?.((agentSlug, sessionId) =>
        dispatch({ channel: 'navigate-to-agent', agentSlug, sessionId }),
      ),
      api.onOpenSettings?.(() => dispatch({ channel: 'open-settings' })),
      api.onOpenCreateAgent?.(() => dispatch({ channel: 'open-create-agent' })),
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe?.())
  }, [dispatch])

  // Replay commands that fired while the window was closed: their live send was
  // queued in the main process because no renderer existed to receive it. The
  // pull happens on mount, when our listeners above are guaranteed attached.
  const flushedRef = useRef(false)
  useEffect(() => {
    if (flushedRef.current) return
    flushedRef.current = true
    window.electronAPI?.flushPendingMenuCommands?.().then((commands) => {
      for (const command of commands) dispatch(command)
    })
  }, [dispatch])

  return null
}
