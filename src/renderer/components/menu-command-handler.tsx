import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiTarget } from '@renderer/lib/api-target'
import { useDialogs } from '../context/dialog-context'
import { useCreateUntitledAgent } from '../hooks/use-create-untitled-agent'
import { useTargetSwitch } from '../hooks/use-target-switch'

/**
 * A command from the native application menu / tray / deep links / Spotlight.
 * The navigate-to-agent channel also carries an optional sessionId (deep links,
 * Spotlight); menu items only supply the agent slug. switch-target comes from a
 * Spotlight result that belongs to the other Superagent.
 */
type MenuCommand =
  | { channel: 'navigate-to-agent'; agentSlug: string; sessionId?: string | null }
  | { channel: 'open-settings' }
  | { channel: 'open-create-agent' }
  | { channel: 'switch-target'; target: ApiTarget }

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
  const { switchTo, ready: canSwitch } = useTargetSwitch()

  // The same path as pressing Local/Cloud, checks and banners included. A
  // request replayed on a fresh window's mount arrives before the platform
  // status that Cloud is judged on, so it waits for that. A switch that does
  // not happen is reported, so main drops the result it was going to open.
  const [requestedTarget, setRequestedTarget] = useState<ApiTarget | null>(null)
  useEffect(() => {
    if (!requestedTarget || !canSwitch) return
    setRequestedTarget(null)
    void switchTo(requestedTarget).then((switched) => {
      if (!switched) window.electronAPI?.declineTargetSwitch?.()
    })
  }, [requestedTarget, canSwitch, switchTo])

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
          void createUntitledAgent({ surface: 'app_menu' })
          break
        case 'switch-target':
          setRequestedTarget(command.target)
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
      api.onSwitchTarget?.((target) => dispatch({ channel: 'switch-target', target })),
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
