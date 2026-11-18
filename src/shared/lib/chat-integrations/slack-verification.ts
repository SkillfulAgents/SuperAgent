import type { VerificationProfile } from '../services/webhook-endpoint-schema'

/** How the endpoint checks Slack's v0 signature: `v0=` hex HMAC-SHA256 of `v0:{timestamp}:{body}`. */
export function slackVerificationProfile(signingSecret: string): VerificationProfile {
  return {
    algorithm: 'hmac-sha256',
    encoding: 'hex',
    header: 'x-slack-signature',
    prefix: 'v0=',
    template: 'v0:{timestamp}:{body}',
    timestamp_header: 'x-slack-request-timestamp',
    secret: signingSecret,
  }
}
