import { vi } from 'vitest'

/**
 * Stands in for `@renderer/lib/oauth-popup` so a test never opens a window:
 *
 *   vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
 *
 * `fakeLoginWindow` records what the login-window hook did: `prepare` per
 * click, `navigate` with the sign-in URL, `close` when the site is done.
 * A message dispatched with `source: fakeLoginWindow.source` comes from it.
 */
export const fakeLoginWindow = {
  prepare: vi.fn(),
  navigate: vi.fn(async (_url: string) => {}),
  close: vi.fn(),
  source: new MessageChannel().port1,
  /** Set when the hook opened a sign-in sheet; calling it is the person closing the sheet. */
  cancelAuthSession: null as (() => void) | null,
  /** Whether that sheet was asked to run the native Sign in with Apple prompt first. */
  withApple: false,
}

export function prepareOAuthPopup() {
  fakeLoginWindow.prepare()
  return {
    navigate: fakeLoginWindow.navigate,
    close: fakeLoginWindow.close,
    isSource: (source: MessageEventSource | null) => source === fakeLoginWindow.source,
  }
}

/** The sign-in sheet stands in as the same fake window; tests cancel it through `cancelAuthSession`. */
export function prepareAuthSession(onCancelled: () => void, withApple = false) {
  fakeLoginWindow.cancelAuthSession = onCancelled
  fakeLoginWindow.withApple = withApple
  return prepareOAuthPopup()
}
