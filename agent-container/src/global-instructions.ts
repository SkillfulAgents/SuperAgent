import { z } from 'zod'

// Mirrors GLOBAL_INSTRUCTIONS_MAX_LENGTH on the host (settings-patch.ts). The
// host enforces it on write; this bound only stops a malformed request from
// putting an unbounded string into every prompt the container renders.
export const GLOBAL_INSTRUCTIONS_MAX_LENGTH = 20_000

// Boundary schema for the org-wide guidance arriving over HTTP (create-session
// / send-message bodies). Absent means "the host did not say" (an older host),
// which keeps whatever the session already has; an empty string clears it.
export const globalInstructionsSchema = z.string().max(GLOBAL_INSTRUCTIONS_MAX_LENGTH).optional()
