import { tool } from '@anthropic-ai/claude-agent-sdk'
import { textResult } from './host-client'
import { webhookRelayAvailable } from '../../webhook-relay-env'

const SLACK_MANIFEST = `{
  "display_information": { "name": "BOT_NAME" },
  "features": {
    "bot_user": { "display_name": "BOT_NAME", "always_online": true },
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "users:read", "chat:write", "files:read", "files:write",
        "im:history", "im:read", "im:write",
        "channels:history", "channels:read",
        "groups:history", "groups:read",
        "mpim:history", "mpim:read",
        "reactions:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": ["message.im", "message.channels", "message.groups", "message.mpim"]
    },
    "interactivity": { "is_enabled": true },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}`

const PROVIDERS_INFO = `Supported agent integration providers. Each gives this agent its own identity; set one up with add_agent_integration.

## Set up by the agent's owner

**Email** (provider \`platform-email\`, Platform-connected deployments)
   The agent's own inbox, with an address like assistant@company.ongamut.so. Not Gmail/Outlook OAuth.
   add_agent_integration asks the owner with a setup card in the app and returns once the inbox is connected. Pass a reason, and optionally \`name\` (sender name) and \`config.localPart\` (the inbox name before the @) as suggestions.
   For an existing inbox, call list_agent_integrations and follow its sending instructions; new emails need no existing conversation.

## Set up by the agent in its browser

**Offer to do these for the user:** you can create the app in your browser and fill everything in. The user only needs to be logged in to the service (ask with request_browser_input when a login page appears) and approve what you ask.

**Linear** (provider \`linear\`)
   The agent's own Linear app: people mention it or delegate issues to it, and it gets Linear tools under its own identity.
   1. add_agent_integration with provider \`linear\`, \`name\` (the app name) and config {webhooks: true} when this host has a webhook relay (see the end of this list; otherwise config {}). It returns a prefilled Linear app creation link.
   2. Open the link, keep the app private and create it. Copy its Client ID, Client secret and (with webhooks) webhook Signing secret.
   3. authorize_agent_integration with those as config {clientId, clientSecret, webhookSecret}, open the link it returns and approve: pick the workspace and the teams the agent works in.

**GitHub** (provider \`github\`, needs a webhook relay)
   The agent's own GitHub App: mentioning it in an issue or pull request starts work, and it acts as its own bot.
   1. add_agent_integration with provider \`github\`, \`name\` (the app name, up to 34 characters) and config {organization} to use an organization's repositories (config {} for the user's own).
   2. authorize_agent_integration, open the link it returns, create the preconfigured app, then install it on the repositories the user chooses.

For the bots below, collect the fields from the user or get them in your browser, and pass them in config.

1. **Telegram**
   Required: \`botToken\` — create a bot via @BotFather on Telegram and copy the token.
   Optional: \`chatId\` — the Telegram chat ID to send messages to. If omitted, the bot will accept messages from anyone who starts a conversation with it.

   Setup steps:
   1. Open Telegram and start a chat with @BotFather
   2. Send /newbot to @BotFather
   3. Pick a name and username ending in "bot"
   4. Copy your bot token from @BotFather

2. **Slack**
   Required:
   - \`botToken\` — Bot User OAuth Token (starts with xoxb-)
   - \`appToken\` — App-Level Token with connections:write scope (starts with xapp-). Required for Socket Mode.
   Optional:
   - \`channelId\` — specific channel to operate in
   - \`onlyMentioned\` — only respond when @mentioned (channels only)
   - \`answerInThread\` — reply in threads instead of the main channel
   - \`newSessionPerThread\` — create a separate agent session for each thread

   **Quick setup (recommended — use app manifest):**
   1. Go to https://api.slack.com/apps
   2. Create New App → From an app manifest → Select the workspace
   3. Paste the following manifest (replace BOT_NAME with the desired bot name):
\`\`\`json
${SLACK_MANIFEST}
\`\`\`
   4. Click Create
   5. In Basic Information → Scroll to App-Level Tokens → Click "Generate Tokens and Scopes"
   6. Name the token → Click "Add Scope" → Select \`connections:write\` → Click Generate
   7. Copy the \`xapp-...\` token — this is the App-Level Token
   8. Go to OAuth & Permissions → Click "Install to {workspace}"
   9. Copy the \`xoxb-...\` Bot User OAuth Token — this is the Bot Token

   **Offer to do this for the user:** Slack setup is complex. Offer to use your browser tools to navigate to api.slack.com/apps, create the app from the manifest, generate the tokens, and configure everything automatically. The user just needs to approve actions along the way.

   **Manual setup (without manifest):**
   1. Go to https://api.slack.com/apps → Create New App → From scratch → Select workspace
   2. Settings → Socket Mode → Toggle ON
   3. Basic Information → App-Level Tokens → Generate with \`connections:write\` scope → Copy xapp-… token
   4. OAuth & Permissions → Bot Token Scopes → Add: chat:write, im:history, im:read, im:write, channels:history, channels:read, groups:history, groups:read, mpim:history, mpim:read, users:read, files:read, files:write, reactions:write
   5. Event Subscriptions → Toggle ON → Subscribe to bot events → Add: message.im, message.channels, message.groups, message.mpim
   6. Interactivity & Shortcuts → Toggle ON
   7. App Home → Messages Tab → Check "Allow users to send Slash commands and messages"
   8. OAuth & Permissions → Install to workspace → Copy xoxb-… Bot Token

3. **iMessage**
   Required:
   - \`phoneNumber\` — your phone number in E.164 format (e.g. +15551234567)
   - \`code\` — 6-digit verification code sent to your phone during setup

   Setup steps:
   1. Text /setup to +12053967934 from the phone number you want to connect
   2. You'll receive a reply with a 6-digit code (expires in 15 minutes)
   3. Provide your phone number and the code
   Note: Only one agent can be connected to iMessage at a time.`

export const listAvailableIntegrationProvidersTool = tool(
  'list_available_integration_providers',
  `List the supported agent integration providers (Email, Linear, GitHub, Telegram, Slack, iMessage), how each is set up, and the configuration fields each needs.

Use this to understand what to collect or do before calling add_agent_integration.

For Slack, Linear and GitHub, offer to do the setup for the user with your browser tools: create the app in the service and fill in what it gives you.`,
  {},
  async () => {
    const relay = webhookRelayAvailable()
      ? 'This host has a webhook relay: set Linear up with webhooks (config {webhooks: true}).'
      : 'This host has no webhook relay: set Linear up without webhooks (config {}); GitHub cannot be set up here.'
    return textResult(`${PROVIDERS_INFO}\n\n${relay}`)
  },
)
