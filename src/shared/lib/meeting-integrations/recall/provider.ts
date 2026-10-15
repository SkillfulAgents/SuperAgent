import type { IntegrationProvider } from '../../agent-integrations/registry'
import type { PublicAgentIntegration } from '../../agent-integrations/public'
import { agentIntegrationMeetings } from '../../db/schema'
import { meetingPolicy, meetingAvailability, meetingLiveSettingFor, leaveOpenMeetings } from '../definitions'
import { recallDefinition } from './definition'
import { recallSetup } from './setup'
import { mergeRecallConfig, recallSettingsOf, type RecallSettings } from './config'
import { resolveRecallTransport } from './transport'

export interface PublicRecallIntegration extends PublicAgentIntegration<RecallSettings> { provider: 'recall' }
export function isPublicRecallIntegration(integration: PublicAgentIntegration): integration is PublicRecallIntegration { return integration.provider === 'recall' }

export const recallProvider: IntegrationProvider = {
  definition: recallDefinition,
  policy: meetingPolicy,
  setup: recallSetup,
  storage: () => [agentIntegrationMeetings],
  // A public page for the bot's browser, and a way to reach Recall (the platform proxy or a host key).
  isAvailable: () => meetingAvailability(resolveRecallTransport() !== null),
  liveSetting: (record, externalId) => {
    const { instructions, voice } = recallSettingsOf(record.config)
    return meetingLiveSettingFor(externalId, { instructions: instructions ?? undefined, voice: voice ?? undefined })
  },
  serialize(record): PublicRecallIntegration {
    const { config, ...fields } = record
    return { ...fields, provider: 'recall', hasCredentials: true, settings: recallSettingsOf(config) }
  },
  // Settings edits arrive as a config PATCH; the installation has no credential, so nothing is ever "moved".
  configuration: {
    identityPaths: [],
    uniqueKey: () => null,
    merge: mergeRecallConfig,
  },
  async create(record) {
    const { RecallMeetingIntegration } = await import('./recall-meeting-integration')
    return new RecallMeetingIntegration(record)
  },
  /** Deleting the installation sends any bot still in a call home; the rows go with the cascade. */
  async cleanup(record) {
    const { recallBotHostFor } = await import('./recall-meeting-integration')
    const host = recallBotHostFor(record)
    if (host) await leaveOpenMeetings(record.id, host)
  },
  async describeTarget() { return { type: 'meeting' } },
}
