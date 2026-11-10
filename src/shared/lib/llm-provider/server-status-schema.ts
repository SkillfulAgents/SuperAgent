import { z } from 'zod'

/**
 * What a provider that runs its own model server (`supportsServerStatus`,
 * `supportsModelDownloads` on BaseLlmProvider) reports about it. Pure: the
 * renderer imports this file.
 */

export const installedModelSchema = z.object({
  /** The name the server answers to. Also the catalog id and wire value. */
  id: z.string(),
  label: z.string(),
  sizeBytes: z.number().optional(),
  contextWindow: z.number().optional(),
  supportsThinking: z.boolean(),
  supportsImageInput: z.boolean(),
  /** Why agents cannot run this model. Absent: it goes in the catalog. */
  unusableReason: z.enum(['no-tools', 'embedding-only']).optional(),
})
export type InstalledModel = z.infer<typeof installedModelSchema>

export const serverStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('running'),
    baseUrl: z.string(),
    version: z.string().optional(),
    /** The server answers but is too old for agents. */
    upgradeRequired: z.boolean(),
    models: z.array(installedModelSchema),
    /** A loaded model whose context is too small for agents, when there is one. */
    smallContext: z.object({ model: z.string(), tokens: z.number() }).optional(),
  }),
  z.object({
    /**
     * `stopped`: an install was found on this machine. `not-found`: none was
     * found (or the app may not look). `unreachable`: the URL is another
     * machine, so nothing can be said about what is installed there.
     */
    state: z.enum(['stopped', 'not-found', 'unreachable']),
    baseUrl: z.string(),
    error: z.string(),
  }),
])
export type ServerStatus = z.infer<typeof serverStatusSchema>

export const modelDownloadSchema = z.object({
  model: z.string(),
  state: z.enum(['running', 'failed']),
  /** The server's last status line, e.g. `verifying sha256 digest`. */
  phase: z.string(),
  completedBytes: z.number(),
  totalBytes: z.number(),
  error: z.string().optional(),
})
export type ModelDownload = z.infer<typeof modelDownloadSchema>
