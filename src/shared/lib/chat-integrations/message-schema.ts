import { z } from 'zod'

/** Decode live input and durable JSON input identically, including Date fields. */
export const incomingMessageSchema = z.object({
  externalMessageId: z.string(), text: z.string(), chatId: z.string(), userId: z.string(),
  chatType: z.enum(['private', 'group', 'supergroup']).optional(), userName: z.string().optional(), chatName: z.string().optional(),
  files: z.array(z.object({ name: z.string(), url: z.string(), mimeType: z.string().optional() })).optional(), timestamp: z.coerce.date(),
  // App-only card hints (ChatMessageDisplayHints); links are validated again when the card is built.
  display: z.object({
    requestText: z.string().optional(), avatarUrl: z.string().optional(), messageUrl: z.string().optional(),
    conversationUrl: z.string().optional(), workspace: z.string().optional(),
  }).optional(),
})
