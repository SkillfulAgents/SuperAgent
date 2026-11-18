# GitHub agent integration

GitHub appears in the agent's existing integration picker when the host is connected to the platform and the webhook relay is available. The provider owns that decision through `GitHubAgentIntegration.isAvailable()`.

## Setup and identity

1. Choose GitHub in the agent's integrations and give its app a unique name.
2. For organization repositories, enter the organization login. Otherwise the app is created on your personal account.
3. Continue to GitHub, approve the preconfigured manifest, and install the app on the repositories it should access.

Each integration owns a separate, private GitHub App. Actions use `app-slug[bot]`, not the person who installed it. The app is installed on its owning account; organization setup requires permission to create and install apps there. The manifest requests Contents, Issues and Pull requests write access, plus Metadata read access. Repository selection further restricts that access.

The bot cannot be selected as an issue assignee or from the native mention picker; type its handle explicitly to invoke it. A custom avatar must be uploaded in the GitHub App's Display information settings; the manifest does not set one.

The generic setup contract supplies a provider-owned POST form and a multi-step callback. Creation exchanges GitHub's temporary manifest code for the app credentials. Installation checks the returned ID with an app-signed JWT and verifies the owning account and granted permissions. Expiring, single-use state protects each phase; retries retain an already-created app.

## Incoming work

Mention `@app-slug` or `@app-slug[bot]` in an issue/PR body, conversation comment, review, or inline review comment. Only repository writers, maintainers, and administrators can invoke the agent. Bot-authored events are ignored. New human comments and submitted reviews on issues/PRs authored by this app automatically invoke the agent without a mention, creating a dedicated issue/PR session on the first invocation. Issues/PRs with an existing integration session or accepted pending input also receive follow-ups in that same session. Unmentioned edits and state changes do not invoke the agent. Closing an issue does not interrupt the agent.

GitHub sends webhooks to the integration's shared relay endpoint. The host verifies the original payload's HMAC and installation ID, then hands accepted input to the existing integration delivery queue. Delivery deduplication, retry, sessions, runtime queueing, and failure notices use shared infrastructure. There is no GitHub polling, history catch-up, or provider-specific durable queue. Context is read only when preparing accepted work; the snapshot includes up to 100 conversation comments and 100 inline comments and marks truncation.

Comment invocations receive an eyes reaction after durable acceptance. The agent decides whether a comment needs action or a response and may finish without posting. Normal assistant output stays in the app; injected guidance directs the agent to publish any intended response through its GitHub MCP identity. Inline review replies go to the original review thread; ordinary comments and submitted reviews receive main issue/PR conversation comments. Host-generated failure notices use the original conversation or inline review thread.

## Outbound access and lifecycle

The integration publishes GitHub's official remote MCP through the existing MCP proxy. Installation tokens stay on the host, expire after an hour, and are renewed on demand with concurrent renewals coalesced. Pause, deletion, and reauthorization invalidate access. MCP discovery refreshes on connect and incoming work, without a provider timer. The common proxy supplies tool execution and audit trails in ordinary sessions as well as GitHub sessions.

App/installation revocation signals the shared reconnect-needed lifecycle. A transient permission/rate-limit or upstream failure does not cancel work or revoke the app. Reconnecting can bind a new installation ID after uninstall/reinstall. Deleting the local integration releases its relay endpoint; it does not delete the customer's GitHub App. A deleted app or removed signing key requires creating a new integration/app.

GitHub Enterprise Server and apps installed across multiple owning accounts are outside this first version. Creation, signed delivery, token renewal, proxy projection, and UI flows have mocked automated coverage. Live verification with a real GitHub App and LLM access is complete, including installation, bot-authenticated replies, automatic follow-ups on bot-created issues/PRs, and inline review replies.

## References

- [GitHub App manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Setup URL and installation ID verification](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
- [Installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [GitHub MCP authentication policies](https://github.com/github/github-mcp-server/blob/main/docs/policies-and-governance.md)
