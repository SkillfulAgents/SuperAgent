/**
 * What the suite actually asserts.
 *
 * Each check is independent enough to read on its own, and they run in order
 * because the cheap ones surface a broken environment before the slow ones
 * spend a container turn on it. A check that leaves the session parked on a
 * user-input request is responsible for clearing it (see `clearPending`) so the
 * next check starts from an idle session.
 *
 * Adding a check: push an entry with a stable `id`, a `title` that reads as the
 * behaviour being protected, and `tags` so it can be selected with --only.
 */

import { messageText, buttonActionIds, buttonLabels } from './conversation.mjs'

/** Distinct per run so an assertion can never match an earlier run's message. */
export function nonce() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

const contains = (needle) => (_message, text) => text.includes(needle)

/**
 * The exact tail describeUnsupportedRequest() appends, rebuilt from the host
 * shape the app was booted with. Asserting the whole tail (not just "some
 * link") is what makes this a regression test for the host-aware notice: a
 * desktop-shaped link leaking into a cloud host, or a session-less fallback
 * where an identity was available, both fail here.
 */
export function expectedTail({ isDesktop, appLinkBase }, sessionId) {
  const url = appLinkBase ? `${appLinkBase}/sessions/${encodeURIComponent(sessionId)}` : null
  return ` Open Gamut${isDesktop ? ' on your desktop' : ''} to continue${url ? `: ${url}` : '.'}`
}

/** Wait until the agent's session has an open request of `kind` in the registry. */
async function awaitRegistryKind(ctx, kind, timeoutMs = 60_000) {
  const start = Date.now()
  for (;;) {
    const open = await ctx.api.pendingRequests(ctx.agentSlug)
    const match = open.find((r) => r.kind === kind)
    if (match) return match
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `No open ${kind} request in the registry after ${Math.round((Date.now() - start) / 1000)}s ` +
          `(open: ${open.map((r) => r.kind).join(', ') || 'none'})`,
      )
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
}

/**
 * Watch the registry for `kind` from *before* the trigger is sent.
 *
 * Polling only after the Slack notice lands is a race: a request can be
 * registered and settled inside one poll interval (a subagent that dies, a
 * tool that errors immediately), and the check would then report "never
 * registered" for something that did register. Starting the watch first turns
 * that into a reliable observation.
 */
function watchRegistry(ctx, kind, { intervalMs = 500 } = {}) {
  let seen = null
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      try {
        const open = await ctx.api.pendingRequests(ctx.agentSlug)
        const match = open.find((r) => r.kind === kind)
        if (match && !seen) seen = match
      } catch {
        /* the app is allowed to be briefly unreachable */
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  })()
  return {
    async stop() {
      stopped = true
      await loop
      return seen
    },
  }
}

async function awaitRegistryEmpty(ctx, timeoutMs = 60_000) {
  const start = Date.now()
  for (;;) {
    const open = await ctx.api.pendingRequests(ctx.agentSlug)
    if (open.length === 0) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Registry still holds ${open.map((r) => `${r.kind}:${r.id}`).join(', ')}`)
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
}

/**
 * Clear a parked request the way a real user does: send an unrelated message.
 * That is the production cancel path (consumeOrCancelAwaitingInput), so using
 * it here means teardown is itself covered rather than being a back door.
 */
async function clearPending(ctx) {
  const open = await ctx.api.pendingRequests(ctx.agentSlug)
  if (open.length === 0) return
  const tag = nonce()
  await ctx.conv.say(`Never mind that. Reply with exactly: CLEARED ${tag}`)
  await ctx.conv.awaitBot(`CLEARED ${tag}`, contains(`CLEARED ${tag}`), 180_000)
  await awaitRegistryEmpty(ctx)
}

/** The chat session the integration is currently using for this conversation. */
async function currentSessionId(ctx) {
  const sessions = await ctx.api.chatSessions(ctx.integrationId)
  const mine = sessions.filter(
    (s) => (s.externalChatId ?? s.external_chat_id) === ctx.conv.channelId && !(s.archivedAt ?? s.archived_at),
  )
  if (mine.length === 0) throw new Error('No chat-integration session for this conversation yet')
  return mine[0].sessionId ?? mine[0].session_id
}

/**
 * One unsupported-in-chat kind: the notice's wording, its host-aware link, the
 * absence of any interactive card, and the request staying parked in the
 * registry (the notice tells the user to go elsewhere — it does not answer).
 */
function unsupportedCheck({ id, kind, prompt, phrase, requiresParked = true, tags = [] }) {
  return {
    id,
    title: `${kind} is refused in chat with the host-aware notice${requiresParked ? ' and stays parked' : ''}`,
    tags: ['unsupported', 'notice', ...tags],
    async run(ctx) {
      const watcher = watchRegistry(ctx, kind)
      let notice
      try {
        await ctx.conv.say(prompt)
        notice = await ctx.conv.awaitBot(`the ${kind} notice`, contains(phrase), 240_000)
      } finally {
        if (!notice) await watcher.stop()
      }
      const text = messageText(notice)
      const sessionId = await currentSessionId(ctx)
      const tail = expectedTail(ctx.hostShape, sessionId)

      if (!text.endsWith(tail)) {
        throw new Error(`Notice tail mismatch.\n  expected ending: ${tail}\n  actual notice:   ${text}`)
      }
      if (buttonActionIds(notice).length > 0) {
        throw new Error(
          `Unsupported-in-chat notice must not render an interactive card: ${buttonLabels(notice).join(', ')}`,
        )
      }

      const request = await watcher.stop()
      if (requiresParked && !request) {
        throw new Error(
          `The notice was sent but no ${kind} request was ever registered — the chat surface told ` +
            `the user to finish this in the app, so something must be waiting for them there`,
        )
      }
      if (request?.scope?.sessionId && request.scope.sessionId !== sessionId) {
        throw new Error(
          `Notice links session ${sessionId} but the request is scoped to ${request.scope.sessionId}`,
        )
      }
      return `linked ${sessionId}${request ? '' : ' (request not parked — see title)'}`
    },
    async cleanup(ctx) {
      await clearPending(ctx)
    },
  }
}

export const CHECKS = [
  {
    id: 'inbound-turn',
    title: 'an inbound message creates a chat session and the agent replies',
    tags: ['smoke'],
    async run(ctx) {
      const tag = nonce()
      await ctx.conv.say(`Reply with exactly: HELLO ${tag}`)
      await ctx.conv.awaitBot(`HELLO ${tag}`, contains(`HELLO ${tag}`), 300_000)
      // The chat session is real on the host side too, not just a Slack echo:
      // the conversation is bound to a container session whose transcript holds
      // the turn. (Chat sessions stay out of the agent's session LIST until
      // promoted, so absence there is expected, not a failure.)
      const sessionId = await currentSessionId(ctx)
      const messages = await ctx.api.messages(ctx.agentSlug, sessionId)
      if (messages.length === 0) {
        throw new Error(`Session ${sessionId} has no persisted messages`)
      }
      return `session ${sessionId}, ${messages.length} messages`
    },
  },

  {
    id: 'question-card',
    title: 'AskUserQuestion renders a Block Kit card with one button per option',
    tags: ['question', 'card'],
    async run(ctx) {
      await ctx.conv.say(
        'Use the AskUserQuestion tool to ask me exactly one question: "Pick a color" ' +
          'with the options "Red" and "Blue". Wait for my answer.',
      )
      const card = await ctx.conv.awaitBot('the question card', contains('Pick a color'), 240_000)
      const labels = buttonLabels(card)
      const actionIds = buttonActionIds(card)
      if (labels.length !== 2 || !labels.includes('Red') || !labels.includes('Blue')) {
        throw new Error(`Expected Red/Blue buttons, got: ${JSON.stringify(labels)}`)
      }
      if (!actionIds.every((a) => /^cb_\d+$/.test(a))) {
        throw new Error(`Button action_ids must be the connector's registered callbacks: ${actionIds.join(', ')}`)
      }
      const request = await awaitRegistryKind(ctx, 'question')
      return `${actionIds.length} buttons, request ${request.id}`
    },
  },

  {
    id: 'question-freetext-answer',
    title: 'a plain-text reply answers the open question and the same turn continues',
    tags: ['question', 'answer'],
    async run(ctx) {
      // Depends on question-card leaving a single-question card open: that is
      // the only shape the free-text path consumes.
      const open = await ctx.api.pendingRequests(ctx.agentSlug)
      if (!open.some((r) => r.kind === 'question')) {
        throw new Error('No open question to answer — question-card must run first')
      }
      const tag = nonce()
      await ctx.conv.say(`Green ${tag}`)
      await ctx.conv.awaitBot('the agent to use the free-text answer', contains(tag), 240_000)
      await awaitRegistryEmpty(ctx)
      return 'answered as the free-form option'
    },
  },

  {
    id: 'question-cancelled-by-unrelated-message',
    title: 'an unrelated message cancels an open question instead of deadlocking',
    tags: ['question', 'cancel'],
    async run(ctx) {
      await ctx.conv.say(
        'Use the AskUserQuestion tool to ask me exactly one question: "Pick a fruit" ' +
          'with the options "Apple" and "Pear". Wait for my answer.',
      )
      await ctx.conv.awaitBot('the second question card', contains('Pick a fruit'), 240_000)
      await awaitRegistryKind(ctx, 'question')

      const tag = nonce()
      await ctx.conv.say(`Forget the fruit. What is 6 times 7? Reply with exactly: ANSWER ${tag} 42`)
      await ctx.conv.awaitBot(`ANSWER ${tag} 42`, contains(`ANSWER ${tag} 42`), 240_000)
      await awaitRegistryEmpty(ctx)
      return 'cancelled and the fresh turn ran'
    },
  },

  {
    id: 'question-multi-is-not-consumed-by-text',
    title: 'a multi-question card posts one message per question and text does not answer it',
    tags: ['question', 'card'],
    async run(ctx) {
      await ctx.conv.say(
        'Use the AskUserQuestion tool to ask me TWO questions in one call: "Pick a size" with ' +
          'options "Small" and "Large", and "Pick a shape" with options "Circle" and "Square". ' +
          'Wait for my answers.',
      )
      const first = await ctx.conv.awaitBot('the size question', contains('Pick a size'), 240_000)
      const second = await ctx.conv.awaitBot('the shape question', contains('Pick a shape'), 120_000)
      if (first.ts === second.ts) {
        throw new Error('Both questions landed in one message — each must be its own card')
      }
      for (const [label, card] of [['size', first], ['shape', second]]) {
        if (buttonActionIds(card).length !== 2) {
          throw new Error(`The ${label} card has ${buttonActionIds(card).length} buttons, expected 2`)
        }
      }

      // Free text only answers a SINGLE-question card; with more than one open
      // the message has to fall through and cancel instead, or an answer would
      // be silently attributed to the wrong question.
      const tag = nonce()
      await ctx.conv.say(`Actually stop. Reply with exactly: STOPPED ${tag}`)
      await ctx.conv.awaitBot(`STOPPED ${tag}`, contains(`STOPPED ${tag}`), 240_000)
      await awaitRegistryEmpty(ctx)
      return 'two cards, text cancelled rather than answered'
    },
  },

  {
    id: 'file-delivery-notice',
    title: 'deliver_file reaches the conversation as a delivery message',
    tags: ['file-delivery'],
    async run(ctx) {
      const tag = nonce()
      await ctx.conv.say(
        `Create a file at /workspace/validation-${tag}.txt containing the text ${tag}, then use ` +
          `the mcp__user-input__deliver_file tool to deliver it to me with the description ` +
          `"validation artifact ${tag}".`,
      )
      // deliver_file uploads the real bytes and uses the description as the
      // caption; it falls back to a text message only when the host can't read
      // the file. Either shape counts as delivered, but the tool-call echo
      // (`🔧 Write — validation-….txt`) does NOT — matching on the filename
      // alone passes on that echo and tests nothing.
      const delivered = await ctx.conv.awaitBot(
        'the delivered file',
        (message, text) =>
          (message.files ?? []).some((f) => (f.name ?? '').includes(`validation-${tag}`)) ||
          (text.includes('File ready') && text.includes(`validation-${tag}.txt`)),
        300_000,
      )
      const uploaded = (delivered.files ?? [])[0]
      const text = messageText(delivered)
      if (!text.includes(`validation artifact ${tag}`)) {
        throw new Error(`Delivery dropped the description: ${text.slice(0, 160)}`)
      }
      return uploaded
        ? `uploaded ${uploaded.name} (${uploaded.size ?? '?'} bytes)`
        : 'text fallback — the host could not read the file'
    },
    async cleanup(ctx) {
      await clearPending(ctx)
    },
  },

  unsupportedCheck({
    id: 'unsupported-secret',
    kind: 'secret',
    prompt:
      'Use the mcp__user-input__request_secret tool to ask me for a secret named ' +
      'VALIDATION_TOKEN, with the reason "chat validation". Do not guess a value.',
    phrase: "needs the secret VALIDATION_TOKEN, which isn't safe to provide in chat",
  }),

  unsupportedCheck({
    id: 'unsupported-file',
    kind: 'file',
    prompt:
      'Use the mcp__user-input__request_file tool to ask me to upload a file ' +
      'described as "a logo image".',
    // The parenthetical carries the agent's own wording, so only the fixed
    // parts of the sentence are asserted here; the tail check below is exact.
    phrase: 'wants you to upload a file',
  }),

  unsupportedCheck({
    id: 'unsupported-connected-account',
    kind: 'connected_account',
    prompt:
      'Use the mcp__user-input__request_connected_account tool to ask me to connect ' +
      'the toolkit "github", with the reason "chat validation".',
    phrase: "wants to connect your github account, which isn't supported in chat",
  }),

  unsupportedCheck({
    id: 'unsupported-remote-mcp',
    kind: 'remote_mcp',
    prompt:
      'Use the mcp__user-input__request_remote_mcp tool to ask me to connect a remote MCP ' +
      'server named "Validation MCP" at https://example.com/mcp, reason "chat validation".',
    phrase: 'wants to connect to a remote MCP server',
  }),

  unsupportedCheck({
    id: 'unsupported-browser-input',
    kind: 'browser_input',
    prompt:
      'Use the mcp__user-input__request_browser_input tool to ask me to sign in, with the ' +
      'message "please sign in".',
    phrase: "needs input in a browser session, which isn't supported in chat",
    // request_browser_input is only in the web-browser subagent's tool list, so
    // the main agent reaches it indirectly and the registration can settle with
    // the subagent before a poll sees it. The notice is the assertion that
    // matters here; the parked-request invariant is covered by the other kinds.
    requiresParked: false,
  }),

  unsupportedCheck({
    id: 'unsupported-script-run',
    kind: 'script_run',
    // The one notice whose wording is about approval rather than support —
    // it is also the one with a host-side side effect behind it.
    prompt:
      'Use the mcp__user-input__request_script_run tool to run the shell script `sw_vers` ' +
      'with the explanation "chat validation".',
    phrase: 'wants to run a script, which needs your approval.',
  }),
]

/** Checks that drive the user's real machine — opt-in only. */
export const OPT_IN_CHECKS = [
  unsupportedCheck({
    id: 'unsupported-computer-use',
    kind: 'computer_use',
    tags: ['computer-use'],
    prompt:
      'Use a computer-use tool to take a screenshot of my screen. If computer use is ' +
      'unavailable, say exactly: COMPUTER USE UNAVAILABLE.',
    phrase: "wants to use your computer, which isn't supported in chat",
  }),
]
