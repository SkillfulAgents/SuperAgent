import { z } from 'zod'

export const inputSchema = z.record(z.string(), z.unknown())
export const telegramResultSchema = z.object({ ok: z.boolean(), result: z.object({ username: z.string().optional(), first_name: z.string().optional() }).optional() })
export const slackResultSchema = z.object({ ok: z.boolean(), team: z.string().optional(), user: z.string().optional(), error: z.string().optional() })
export const tokenResultSchema = z.object({ token: z.string().min(1) })

