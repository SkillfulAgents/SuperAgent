# Commerce MCP catalog validation — 2026-09-21

Only official servers that passed dynamic client registration (DCR) and rendered a real sign-in page in Chromium were added. Existing entries were checked for duplicates before any edits. No account credentials were entered, no authorization codes were exchanged, and authenticated tools were not exercised.

## Catalog decisions

| Service | Decision | Official source and validation result |
| --- | --- | --- |
| ShipBob | Already present as `shipbob`; unchanged | [Official setup](https://developer.shipbob.com/mcp-server/setup). `https://api.shipbob.com/developer-api/mcp` passed the application's DCR flow. Chromium followed the authorization redirect to `auth.shipbob.com/Account/Login` (HTTP 200), with visible username and password fields. |
| Triple Whale | Added as `triple-whale` | [Official MCP guide](https://kb.triplewhale.com/en/articles/15656798-triple-whale-mcp). `https://mcp.triplewhale.com/v1/mcp` passed the application's DCR flow. Chromium reached `app.triplewhale.com/signin` (HTTP 200), titled “Sign In \| Triple Whale”, with visible email and password fields. |
| Shippo | Already present as `shippo`; unchanged | [Official server documentation](https://github.com/goshippo/ai/blob/main/docs/openai-responses-mcp.md). The existing `https://mcp.shippo.com` bearer entry did **not** pass DCR/OAuth validation. The MCP handshake returned HTTP 401, “Missing Bearer token”, without `WWW-Authenticate`; the authorization-server metadata URL returned HTTP 403. No OAuth login URL could be generated. |
| Shopify Storefront | Not added | [Official Storefront MCP documentation](https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront). Storefront MCP is unauthenticated and uses a merchant-specific endpoint, `https://{shop}.myshopify.com/api/mcp`. It does not provide the requested DCR/OAuth login flow. No merchant domain was supplied. |
| WooCommerce | Not added | [Official MCP integration documentation](https://developer.woocommerce.com/docs/features/mcp/). Remote HTTP access uses a store-specific WordPress MCP Adapter endpoint and WordPress Application Password authentication. No shared official DCR/OAuth endpoint was established, and no store instance was supplied for testing. Third-party marketplace extensions were not substituted. |
| ShipStation | Not added | [Official API MCP repository](https://github.com/shipstation/mcp-shipstation-api) documents local Node/Docker execution with `SHIPSTATION_API_KEY`. Its [hosted documentation MCP](https://docs.shipstation.com/connect-mcp) serves documentation rather than authenticated shipping operations. Neither documented option provides the required DCR/OAuth login flow. |
| Easyship | Not added | [Official MCP guide](https://developers.easyship.com/docs/easyship-mcp-server). `https://mcp.easyship.com/mcp` advertises OAuth and `https://mcp.easyship.com/oauth/register`, but live DCR rejected every tested app/local callback with HTTP 400 `invalid_redirect_uri`. No valid authorization URL was generated. This establishes failure for the tested callbacks, not that Easyship lacks OAuth entirely. |
| Klaviyo | Already present as `klaviyo`; unchanged | [Official remote MCP setup](https://help.klaviyo.com/hc/en-us/articles/52833598880923). `https://mcp.klaviyo.com/mcp` passed DCR and rendered a pre-login client approval page. After the user explicitly approved continuing through that prompt, Chromium reached `www.klaviyo.com/login`, titled “Log In \| Klaviyo”, with visible email/password fields. Prompt-intent collection was unchecked; no credentials were entered. |
| Gorgias | Already present as `gorgias`; unchanged | [Official MCP guide](https://docs.gorgias.com/en-US/connect-your-ai-assistant-to-the-gorgias-mcp-6310546). The application's initial unauthenticated discovery listed 126 tool definitions and did not receive the 401 needed to initiate OAuth. Separately fetching the advertised metadata and using the application's DCR helper succeeded; its generated authorization URL rendered “Connect to Gorgias MCP” (HTTP 200), requesting a Gorgias subdomain. A tenant-specific credential page was **not** verified because no subdomain was supplied. This is not a full application-flow pass. |
| TrueProfit | Added as `trueprofit` | [Official MCP setup](https://helpdesk.trueprofit.io/en/articles/14086381-trueprofit-mcp-connect-trueprofit-to-chatgpt-claude-and-openclaw-clawdbot). `https://mcp.trueprofit.io/mcp` passed the application's DCR flow. Its authorization page returns HTTP 401 but renders a genuine “Sign In Required” page with an “Open TrueProfit” link. Following that link in Chromium reached `app.trueprofit.io/sign-in`, with Google, Apple, email, and Shopify sign-in choices. Added setup guidance for signing in with a TrueProfit account and returning to refresh the authorization page. |
| Amazon Ads | Not added | [Official MCP overview](https://advertising.amazon.com/API/docs/en-us/mcp/mcp-overview). `https://advertising-ai.amazon.com/mcp` exposes OAuth metadata pointing to `https://lwa.amazon.com/ap/oa` and `https://api.amazon.com/auth/o2/token`, but no `registration_endpoint`. The application's flow stopped with “provide an OAuth Client ID”; DCR and a client-specific login URL could not be verified. |
| FastMoss | Not added | [Official MCP setup](https://developers.fastmoss.com/docs/mcp/setup). `https://mcp.fastmoss.com/mcp` passed DCR through `/oauth/register`, and `/oauth/authorize` redirected to `developers.fastmoss.com/mcp/oauth/authorize.html`. Chromium then received HTTP 567, titled “Access Restricted”, displaying Tencent Cloud EdgeOne's restricted-access page. This fails the real-login-page requirement despite the successful initial redirect. |

## Method

The nine public candidate endpoints were probed with `scripts/verify-mcp-server.ts --auth oauth` (batch mode), exercising `discoverOAuthMetadata` and `initiateNewServerOAuth` from the application. Registration used the application client name, `Gamut`, and the verifier's `http://localhost:9999/mcp-oauth-callback`. The application generated authorization URLs with S256 PKCE, state, resource, and discovered scopes.

The existing verifier's `supported` flag is deliberately broader than this task's acceptance rule: it can accept bearer servers, manual OAuth clients, a 3xx redirect, or an HTTP 401 handshake. Those results were **not** treated as proof that DCR and browser login passed. Authorization URLs were opened in fresh Chromium contexts, rendered text and visible controls were inspected, and screenshots were visually checked. TrueProfit's HTTP 401 was evaluated by its rendered sign-in content rather than rejected solely for its status code.

Easyship was additionally tested with these callback formats, all rejected at registration:

- `gamut://mcp-oauth-callback`
- `http://localhost:5000/api/remote-mcps/oauth-callback`
- `http://127.0.0.1:5000/api/remote-mcps/oauth-callback`
- `https://localhost:5000/api/remote-mcps/oauth-callback`

Gorgias's separate protocol check fetched `https://mcp.gorgias.com/.well-known/oauth-authorization-server`, called the application's `registerDynamicClient` helper, and built a PKCE authorization URL from the returned client ID. This was necessary because its public initialization response did not trigger the application's automatic OAuth discovery. No guessed tenant was entered.

## Repository verification

The host catalog contains the two additions; the agent catalog was regenerated from it. Existing entries were not duplicated or removed.

```sh
node_modules/.bin/vitest run \
  src/shared/lib/mcp/agent-catalog-parity.test.ts \
  src/renderer/components/connections/mcp-setup-guide.test.tsx
```

Result: **21 tests passed** across 2 files, including catalog parity and unique slugs. ESLint passed for the modified host catalog, and `git diff --check` passed. Validation stops at the sign-in boundary; account authorization, token exchange, and authenticated tool calls remain untested, as requested.
