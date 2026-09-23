import { z } from 'zod'
export const MAX_TRACKED_SLACK_THREADS = 1000
export const slackParticipationSchema = z.object({ botUserId: z.string(), activeThreads: z.array(z.string()).max(MAX_TRACKED_SLACK_THREADS) })
