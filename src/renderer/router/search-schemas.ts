import { z } from 'zod'
import { isSafeInternalPath } from '@renderer/lib/api'

/**
 * Zod schemas for the router's URL boundary (search params + the settings tab
 * path param). Per CLAUDE.md, every value decoded from the URL is validated here
 * before it reaches a route component.
 */

// Chat sub-session is optional → SEARCH, not a path segment: the chat root and a
// specific sub-session are the same view (`view.sessionId` is `string?` on the
// `chat` variant of AgentView). NOT `.uuid()` — legacy/test session ids may not
// be UUID-shaped (see migration plan §13).
export const chatSearchSchema = z.object({
  session: z.string().optional(),
})

// Connections detail overlay on the list. `detail` is the unified-row key
// (`account-${id}` / `mcp-${id}`, see connections/unified-rows.ts); `source`
// decides the breadcrumb + back-target. They travel together — today both live
// inside one optional `detail` object on the `connections` AgentView variant.
export const connectionsSearchSchema = z
  .object({
    detail: z
      .string()
      .regex(/^(account|mcp)-.+$/)
      .optional(),
    source: z.enum(['home', 'list']).optional(),
  })
  .refine((s) => (s.detail == null) === (s.source == null), {
    message: 'detail and source must be set together',
  })

// Open-redirect-safe internal path. ONE definition for the whole app: the same
// `isSafeInternalPath` backstop applied on the actual stash/redirect path in
// api.ts (rejects `//host`, `/\host`, and a leading encoded `/%2f`/`/%5c`), so
// the schema gate and the sanitizer can't drift (review §3.3). Shared by the
// post-login `redirect` (§9) and the settings `from` close-target (§10.1).
const internalPath = z.string().refine(isSafeInternalPath, { message: 'must be a safe internal path' })

// Deep-link-through-login target (migration plan §9).
export const rootSearchSchema = z.object({
  redirect: internalPath.optional(),
})

// Settings close-target: the path the gear was opened FROM, so closing returns
// there. A query param (not an in-memory stash) so it SURVIVES a refresh inside
// settings (§10.1).
export const settingsSearchSchema = z.object({
  from: internalPath.optional(),
})

// The 18 GLOBAL settings tabs (settings/global-settings-page.tsx user/admin/auth
// sections, flattened in display order). NOTE: `system-prompt` and `secrets` are
// deliberately absent — those are agent-scoped local dialogs, not global settings
// routes (migration plan §6.6).
export const SETTINGS_TABS = [
  'profile',
  'general',
  'notifications',
  'platform',
  'connections',
  'usage',
  'llm',
  'runtime',
  'browser',
  'computer-use',
  'account-provider',
  'voice',
  'skillsets',
  'analytics',
  'audit-log',
  'admin',
  'users',
  'auth',
] as const

export const settingsTabSchema = z.enum(SETTINGS_TABS)
export type SettingsTab = z.infer<typeof settingsTabSchema>
