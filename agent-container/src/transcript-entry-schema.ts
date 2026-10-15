import { z } from 'zod';

/** The two fields of a transcript line the elapsed-time note reads. */
export const transcriptEntrySchema = z.object({
  type: z.string(),
  timestamp: z.string(),
});

/** A transcript line's identity and time; a line the SDK's forkSession copied also names its source line. */
export const forkEntrySchema = z.object({
  uuid: z.string(),
  timestamp: z.string(),
  forkedFrom: z.object({ messageUuid: z.string() }).optional(),
});
