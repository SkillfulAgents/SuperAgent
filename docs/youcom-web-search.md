# You.com web search

Select **Settings → Web → You.com** to use the You.com Search MCP. With no API
key it calls the free profile at `https://api.you.com/mcp?profile=free` (about
100 searches a day, no account). An optional You.com API key, saved in Settings
or set as `YDC_API_KEY`, uses the authenticated endpoint at
`https://api.you.com/mcp` and lifts that daily limit. Start a new agent session
after changing the provider. You.com search works with every model; page reading
continues to use the model's built-in tools where available.

The selection is saved as `webProvider: "youcom"`. It is opt-in: when no
provider is selected, Gamut remains the default when signed in, otherwise
Native. Existing Native, Exa, Parallel, and Gamut selections retain their
behavior.

The host performs MCP initialization, tool discovery and `you-search`, and maps
results to the existing ranked hits and agent tool text. Requests to You.com
send `User-Agent: youdotcom-integration/SkillfulAgents-Gamut` and no other
You.com headers unless a key is set, in which case the host sends
`Authorization: Bearer <key>`. Search requests use the same 15-second
per-request timeout and transient retry policy as the other host providers.

Result count is capped locally. Domain and publication-date constraints are
enforced on returned hits. A requested domain also matches its subdomains.
Results without a usable publication date are kept when a date range is
requested. The host's allowed and blocked site policy still applies. A provider
failure is reported to the agent rather than silently switching providers.

See the [You.com MCP Server documentation](https://you.com/docs/agents/mcp-server?utm_source=SkillfulAgents-Gamut&utm_medium=oss_integration&utm_campaign=2026-11-oss-integrations)
for the service's free-tier limits and tool interface. Privacy policy:
https://you.com/privacy
