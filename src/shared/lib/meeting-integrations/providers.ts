import type { MeetingIntegrationProvider } from './bot-host'
import { recallProvider } from './recall/provider'

export const meetingProviders: readonly MeetingIntegrationProvider[] = [recallProvider]
