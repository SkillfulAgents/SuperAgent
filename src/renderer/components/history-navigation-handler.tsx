import { useEffect } from 'react'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { useHistoryNavigation } from '@renderer/router/use-history-navigation'

type HistoryNavigationCommand = 'back' | 'forward'

function isBracketKey(event: KeyboardEvent, bracket: '[' | ']'): boolean {
  const code = bracket === '[' ? 'BracketLeft' : 'BracketRight'
  return event.key === bracket || event.code === code
}

function getKeyboardNavigationCommand(event: KeyboardEvent): HistoryNavigationCommand | null {
  if (event.defaultPrevented || event.repeat) return null

  const bracketModifier =
    getPlatform() === 'darwin'
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey

  if (bracketModifier && !event.altKey && !event.shiftKey) {
    if (isBracketKey(event, '[')) return 'back'
    if (isBracketKey(event, ']')) return 'forward'
  }

  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
    if (event.key === 'ArrowLeft') return 'back'
    if (event.key === 'ArrowRight') return 'forward'
  }

  return null
}

function getMouseNavigationCommand(event: MouseEvent): HistoryNavigationCommand | null {
  if (event.defaultPrevented) return null
  if (event.button === 3) return 'back'
  if (event.button === 4) return 'forward'
  return null
}

/**
 * App-local browser-style history shortcuts for Electron. Mounted at the root
 * so it survives the shell/settings route switch and drives TanStack history
 * rather than Electron's document navigation stack.
 */
export function HistoryNavigationHandler() {
  const { back, forward } = useHistoryNavigation()

  useEffect(() => {
    if (__WEB__ || !isElectron()) return

    const dispatch = (command: HistoryNavigationCommand) => {
      if (command === 'back') back()
      else forward()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const command = getKeyboardNavigationCommand(event)
      if (!command) return
      event.preventDefault()
      dispatch(command)
    }

    const handleMouseNavigation = (event: MouseEvent) => {
      const command = getMouseNavigationCommand(event)
      if (!command) return
      event.preventDefault()
      dispatch(command)
    }

    const unsubscribeNativeCommand = window.electronAPI?.onHistoryNavigationCommand?.(dispatch)

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('mousedown', handleMouseNavigation, true)
    window.addEventListener('auxclick', handleMouseNavigation, true)

    return () => {
      unsubscribeNativeCommand?.()
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('mousedown', handleMouseNavigation, true)
      window.removeEventListener('auxclick', handleMouseNavigation, true)
    }
  }, [back, forward])

  return null
}
