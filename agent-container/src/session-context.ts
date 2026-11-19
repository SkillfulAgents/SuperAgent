import { z } from 'zod';

// What the host sends with a message: who sent it, where, and what started
// the session. Values are the host's; this side keeps them as open strings.
export const messageContextSchema = z.object({
  session_trigger: z.string().optional(),
  sender: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
    type: z.string(),
  }).optional(),
  channel: z.string().optional(),
}).optional();

export type MessageContext = z.infer<typeof messageContextSchema>;
export type SessionContext = NonNullable<MessageContext>;

/** A message's fields replace the session's. A stored context that no longer parses is dropped, not carried. */
export function mergeSessionContext(stored: unknown, incoming: MessageContext): SessionContext | undefined {
  const kept = messageContextSchema.safeParse(stored);
  const base = kept.success ? kept.data : undefined;
  if (!incoming) return base;
  return { ...base, ...incoming };
}
