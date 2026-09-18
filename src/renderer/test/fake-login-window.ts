import { vi } from 'vitest'

/**
 * Stands in for `@renderer/lib/oauth-popup` so a test never opens a window:
 *
 *   vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
 *
 * `fakeLoginWindow` records what the login-window hook did: `prepare` per
 * click, `navigate` with the sign-in URL, `close` when the site is done.
 */
export const fakeLoginWindow = {
  prepare: vi.fn(),
  navigate: vi.fn(async (_url: string) => {}),
  close: vi.fn(),
}

export function prepareOAuthPopup() {
  fakeLoginWindow.prepare()
  return { navigate: fakeLoginWindow.navigate, close: fakeLoginWindow.close }
}
