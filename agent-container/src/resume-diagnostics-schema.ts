import { z } from 'zod';

// Preserve every SDK-owned field. Only the transport hint is ours to remove.
export const diagnosticAssistantSchema = z.object({
  type: z.literal('assistant'),
  requestId: z.string().min(1),
  message: z.object({ id: z.string().min(1) }).passthrough(),
}).passthrough();
