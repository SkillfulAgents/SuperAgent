/** A login window as its owner (`useLoginWindow`) drives it. */
export interface LoginWindow {
  navigate(url: string): Promise<void>
  close(): void
  /** Whether a message came from this window. */
  isSource(source: MessageEventSource | null): boolean
}

/**
 * The Gamut sign-in as a sheet on the app's own window (macOS's
 * ASWebAuthenticationSession), for the builds that must not send the person to
 * their browser to sign in (`signsInWithAuthSession()`).
 *
 * A finished sign-in arrives the way it does from the browser, on the
 * platform-auth callback, and so does a failure. Only the person closing the
 * sheet has no other signal, so that is what `onCancelled` reports.
 */
export function prepareAuthSession(onCancelled: () => void): LoginWindow {
  let closed = false
  return {
    async navigate(url: string) {
      const session = window.electronAPI?.startPlatformSignIn
      if (!session) {
        await window.electronAPI?.openExternal(url)
        return
      }
      // Not awaited: the session lasts as long as the sheet is up, and the
      // caller is waiting only for the sheet to be on its way.
      // A session that could not even be asked for ends the attempt the same
      // way: nothing else would, and the button would stay pending.
      void session(url)
        .catch(() => 'cancelled' as const)
        .then((outcome) => {
          if (outcome === 'cancelled' && !closed) onCancelled()
        })
    },
    close() {
      if (closed) return
      closed = true
      void window.electronAPI?.cancelPlatformSignIn?.()
    },
    isSource: () => false,
  }
}

/**
 * Opens a popup window synchronously (to avoid browser popup blockers)
 * and returns helpers to navigate or close it.
 *
 * Must be called synchronously during a user gesture (click handler),
 * before any async work. After the async work completes, call
 * `navigate(url)` to redirect the popup to the OAuth URL.
 *
 * In Electron, no popup is opened — `navigate` uses `openExternal` instead.
 */
export function prepareOAuthPopup(): LoginWindow {
  const popup = !window.electronAPI ? window.open('about:blank', '_blank') : null

  return {
    async navigate(url: string) {
      if (window.electronAPI) {
        await window.electronAPI.openExternal(url)
      } else if (popup) {
        popup.location.href = url
      }
    },
    close() {
      popup?.close()
    },
    /** Whether a message came from this popup. */
    isSource(source: MessageEventSource | null) {
      return popup !== null && source === popup
    },
  }
}
