# Parallel web search

Select **Settings → Web → Parallel** to use the free, keyless Parallel Search MCP
at `https://search.parallel.ai/mcp`. Start a new agent session after changing the
provider. Parallel search works with every model; page reading continues to use
the model's built-in tools where available. No API key or Gamut account is needed
for this provider. Anonymous requests have lower rate limits than authenticated
Parallel requests. This integration always uses anonymous requests.

The selection is saved as `webProvider: "parallel"`. It is opt-in: when no provider
is selected, Gamut remains the default when signed in, otherwise Native. Existing
Native and Exa selections retain their behavior.

The host performs MCP initialization, tool discovery and `web_search`, and maps
results to the existing ranked hits and agent tool text. It sends a Gamut
User-Agent and does not read saved or environment Parallel credentials. Search
requests use the same 15-second per-request timeout and transient retry policy as
the other host providers.

Result count is capped locally. Domain and publication-date constraints are sent
in the search objective and enforced on returned hits. Results without a usable
publication date are omitted when a date range is requested. The host's allowed
and blocked site policy still applies. A provider failure is reported to the
agent rather than silently switching providers.

See [Parallel Search MCP documentation](https://docs.parallel.ai/integrations/mcp/search-mcp)
for the service's anonymous usage limits and tool interface.
