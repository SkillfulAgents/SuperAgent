import { z } from 'zod'
import type { WebProviderId } from './types'

/** Runtime enum for PUT-boundary validation. Keep members in sync with WebProviderId in types.ts. */
export const WebProviderIdSchema = z.enum(['native', 'exa', 'platform']) satisfies z.ZodType<WebProviderId>
