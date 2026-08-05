/**
 * Choosing the Slack conversation the suite runs in.
 *
 * The surface follows from what the sender is:
 *
 *   human identity → a DM with the bot. Closest to how the feature is really
 *                    used, and the only shape that can open a D… channel.
 *   app identity   → a shared channel. Slack will not let one app post into
 *                    another app's DM, so a channel is the only reachable
 *                    surface.
 *
 * Either way the integration sees an inbound `message` event on a chat id and
 * takes the identical connector path; the channel case additionally exercises
 * channel routing (which, with onlyMentioned off, processes every message).
 */

import { openDirectMessage, memberChannels, joinChannel } from './slack.mjs'

export async function resolveSurface({ sender, botToken, botAuth, preferred, log = () => {} }) {
  if (sender.kind === 'human') {
    const id = await openDirectMessage(sender, botAuth.user_id)
    return { kind: 'dm', channelId: id, label: `DM with ${botAuth.user}` }
  }

  const [botChannels, senderChannels] = await Promise.all([
    memberChannels(botToken),
    memberChannels(sender),
  ])
  const senderIds = new Set(senderChannels.map((c) => c.id))
  const wanted = preferred?.replace(/^#/, '')
  let shared = botChannels.filter((c) => senderIds.has(c.id))

  // The sender app is typically installed but in no channels. It can add itself
  // to a PUBLIC channel the integration bot already sits in (conversations.join
  // needs channels:join and works only for public channels); private ones need
  // a human invite, which the error below spells out.
  if (shared.length === 0) {
    const target =
      (wanted && botChannels.find((c) => c.id === wanted || c.name === wanted)) ??
      botChannels.find((c) => !c.isPrivate)
    if (target && !target.isPrivate) {
      const joined = await joinChannel(sender, target.id)
      if (joined.ok) {
        log(`sender joined #${target.name} (it was in no channel the bot is in)`)
        shared = [target]
      }
    }
  }

  if (shared.length === 0) {
    throw new Error(
      `The integration bot (${botAuth.user}) and the sender (${sender.auth.user}) share no channel, ` +
        `and the sender could not join one on its own. Invite ${sender.auth.user} to a channel ` +
        `${botAuth.user} is in — a channel dedicated to validation is best, since every message ` +
        `in it wakes the agent.\n` +
        `  bot is in:    ${botChannels.map((c) => `#${c.name}`).join(', ') || '(none)'}\n` +
        `  sender is in: ${senderChannels.map((c) => `#${c.name}`).join(', ') || '(none)'}`,
    )
  }

  const pick = (wanted && shared.find((c) => c.id === wanted || c.name === wanted)) ?? shared[0]
  if (wanted && pick.id !== wanted && pick.name !== wanted) {
    throw new Error(
      `Requested channel "${preferred}" is not shared by both identities. Shared: ${shared
        .map((c) => `#${c.name}`)
        .join(', ')}`,
    )
  }
  return {
    kind: 'channel',
    channelId: pick.id,
    label: `#${pick.name}`,
    shared: shared.map((c) => `#${c.name}`),
  }
}
