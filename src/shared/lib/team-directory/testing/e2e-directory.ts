/**
 * The directory a mock server (E2E_MOCK=true) offers besides Slack, so the
 * end-to-end suites and PR screenshots can connect a directory and find its
 * people without a real workspace. Connect it with the token `acme-token`.
 * It goes through every path a real provider does; its DMs stay in memory.
 */
import { createFakeDirectoryProvider } from './fake-directory-provider'
import type { TeamDirectoryProvider } from '../types'

export function e2eDirectoryProvider(): TeamDirectoryProvider<unknown> {
  const demo = createFakeDirectoryProvider('demo', 'Demo Directory')
  demo.setPeople('acme', [
    demo.person('acme', 'D001', 'Dana Whitfield', 'dana@acme.test'),
    demo.person('acme', 'D002', 'Sara Kim', 'sara.kim@acme.test'),
    demo.person('acme', 'D003', 'Daniel Okafor', 'daniel@acme.test'),
    demo.person('acme', 'D004', 'Lee Park', 'lee.park@acme.test'),
    demo.person('acme', 'D005', 'Priya Natarajan', 'priya@acme.test'),
    demo.person('acme', 'D006', 'Unverified Uma', 'uma@acme.test', { emailVerified: false }),
  ])
  return demo.provider as TeamDirectoryProvider<unknown>
}
