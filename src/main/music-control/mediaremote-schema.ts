import { z } from 'zod'

/**
 * One `get` from the MediaRemote adapter: `null` when no app reports now
 * playing information, otherwise a dictionary in which `bundleIdentifier`,
 * `playing` and `title` are always set. Everything else is optional and
 * ignored here.
 */
export const mediaRemoteNowPlayingSchema = z
  .object({
    bundleIdentifier: z.string().min(1),
    /** Set when the client is a helper process, e.g. a Chrome renderer. */
    parentApplicationBundleIdentifier: z.string().min(1).nullable().optional(),
    playing: z.boolean(),
  })
  .passthrough()
  .nullable()

export type MediaRemoteNowPlaying = z.infer<typeof mediaRemoteNowPlayingSchema>
