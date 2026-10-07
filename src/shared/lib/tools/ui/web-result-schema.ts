import { z } from 'zod'

/**
 * One entry of the `Links: [...]` JSON line the search formatter writes
 * (agent-container/src/tools/web/format-results.ts) and this renderer reads back from the
 * transcript. Reader-lenient by design: an entry that doesn't conform is dropped alone rather
 * than failing the batch, and a malformed optional field is dropped without losing its entry.
 *
 * `published` doubles as the format marker: the formatter always writes it (empty string when
 * the vendor gave no date), so its presence tells the parser the date channel is authoritative
 * and a positional `Published:` line in page text must not be trusted. Absent key = a transcript
 * from before the field existed, where the positional line is still the only source.
 */
export const searchLinkSchema = z.object({
  title: z.string(),
  url: z.string(),
  favicon: z.string().optional().catch(undefined),
  // Catch order differs from favicon deliberately: favicon is a display value, so malformed
  // fails open to "absent". published is the trust marker, and undefined means "old format,
  // trust the positional line" - so present-but-malformed must fail closed to '' (refuse),
  // never collapse into the value that grants trust.
  published: z.string().catch('').optional(),
})

export type SearchLink = z.infer<typeof searchLinkSchema>
