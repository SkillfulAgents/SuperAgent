import { z } from 'zod'
import { ExaSearchResultSchema } from './exa-response-schema'

// Zod-at-the-boundary for Exa's POST /contents response. The result object is identical to /search
// (Exa returns the same shape from both endpoints), so we reuse ExaSearchResultSchema — one source
// of truth for the raw Exa result. The fetch map reads only url + title + text + publishedDate;
// everything else passes through, so vendor drift on fields we don't read can't break parsing.
//
// One deliberate relaxation vs search: we send `filterEmptyResults:false`, which KEEPS a
// failed/unextractable-URL stub in results[], and such a stub can OMIT `title` (metadata Exa
// couldn't extract). The shared schema requires `title` to be present, which would throw on exactly
// the stub the flag exists to handle — so we widen `title` to also allow it absent here. `url`
// stays required (it's the echoed request URL, always present).
const ExaContentsResultSchema = ExaSearchResultSchema.extend({
  title: z.string().nullish(),
})

export const ExaContentsResponseSchema = z.object({
  results: z.array(ExaContentsResultSchema),
  requestId: z.string().optional(),
})

export type ExaContentsResponse = z.infer<typeof ExaContentsResponseSchema>
