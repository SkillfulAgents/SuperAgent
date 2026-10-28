import { z } from 'zod';

/** The two fields of a transcript line the elapsed-time note reads. */
export const transcriptEntrySchema = z.object({
  type: z.string(),
  timestamp: z.string(),
});
