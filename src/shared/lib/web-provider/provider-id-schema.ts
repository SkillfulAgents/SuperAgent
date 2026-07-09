import { z } from 'zod'
import type { WebProviderId } from './types'

// Runtime enum for validating the provider id at the PUT boundary. Keep members in sync with the
// union in ./types.ts - the bidirectional drift guard below fails to compile if either side drifts.
export const WebProviderIdSchema = z.enum(['native', 'exa', 'platform'])

// Exact<A,B> is `true` only when A and B are mutually assignable, so this fails to compile if the
// enum gains/loses a member OR the union does (one-directional `satisfies` would miss union-only drift).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _idSync: Exact<z.infer<typeof WebProviderIdSchema>, WebProviderId> = true
void _idSync
