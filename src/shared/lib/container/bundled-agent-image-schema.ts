import { z } from 'zod'

/** The archive's file name inside the bundle folder. */
export const BUNDLED_AGENT_IMAGE_ARCHIVE = 'agent-image.tar'

/** The description's file name inside the bundle folder. */
export const BUNDLED_AGENT_IMAGE_MANIFEST = 'agent-image.json'

/**
 * What scripts/fetch-agent-image.ts writes next to the archive it bundles, and
 * what the app reads before it loads the archive instead of pulling.
 */
export const bundledAgentImageSchema = z.object({
  /** The full reference the archive is tagged with, e.g. ghcr.io/…:0.5.49. */
  image: z.string().min(1),
  /** OCI architecture name: arm64, amd64. */
  architecture: z.string().min(1),
  /** Digest of the platform's image manifest, as the registry serves it. */
  manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Byte size of the archive, so a truncated copy is never loaded. */
  archiveBytes: z.number().int().positive(),
})

export type BundledAgentImage = z.infer<typeof bundledAgentImageSchema>
