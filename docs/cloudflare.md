# Run SuperAgent on Cloudflare

One Cloudflare Worker serves one org: the UI, the API, the database (D1), the files (R2), and one
container per agent. The entry point is `src/cf`; `src/cf/wrangler.jsonc` is its configuration.

## What you need

- A Cloudflare account on the Workers Paid plan (Durable Objects, Containers, and a Worker of this size need it).
- Node 22 and this repository with `npm ci` done.
- Docker running: the deploy builds the agent image from `agent-container/Dockerfile`, adds the Cloudflare layer (`src/cf/container/Dockerfile`), and pushes it to Cloudflare. The first build takes a while.

## Deploy

```sh
npx wrangler login
npx wrangler secret put SUPERAGENT_VAULT_KEY --config src/cf/wrangler.jsonc   # paste: openssl rand -base64 32
npx wrangler secret put BETTER_AUTH_SECRET --config src/cf/wrangler.jsonc     # paste: openssl rand -base64 32
npm run deploy:cf
```

`wrangler secret put` offers to create the Worker when it does not exist yet; accept. The deploy
creates the D1 database and the R2 buckets and writes their ids into `wrangler.jsonc`. Keep that
change: the next deploy uses the same database and buckets.

Open the URL the deploy prints. The first request migrates the database, which takes a few
seconds; a request that arrives before it is done fails, so reload once. The first person who
signs up becomes the admin.

Keep `SUPERAGENT_VAULT_KEY`: saved browser logins are sealed with it, and a Worker cannot make a new one.

## Update

Pull, then `npm run deploy:cf` again. The new code migrates the database when it first runs.

## Options

| Name | Kind | What it does |
| --- | --- | --- |
| `APP_ORIGIN` | variable | The origin browsers use, for example `https://agents.example.com`. Set it when you serve the Worker on your own domain. Unset, the origin of the first request to a deploy is trusted for sign-in. |
| `STORAGE_LOCATION` | variable | Where the database is, as Cloudflare's location hint, for example `wnam`. New Durable Objects are made near it. Unset: each is made near its first caller. |
| `SEED_SETTINGS` | variable | Settings a new org starts from, as JSON. Applied once. |
| `AGENT_INSTANCE_TYPE` | variable | The instance type of each agent's container. Unset: `standard-3` (2 vCPU). |
| `CONTAINER_SNAPSHOT` | variable | A container snapshot agents start from, as JSON (`id`, `name`, `size`). Unset: the image. |
| `DEPLOY_TOKEN` | secret | Lets a deploy script call `POST /_deploy/prepare` with `Authorization: Bearer <token>` right after an upload, so the database is migrated before the new code serves a request. The call answers 503 while Cloudflare still runs the previous code; call it again. |
| `AUTH_PROVIDERS_JSON`, `PLATFORM_TOKEN` | secrets | Only for a deployment that Gamut Platform manages. |

The Worker uses Smart Placement (`placement` in `wrangler.jsonc`): once Cloudflare has seen enough of its traffic, it runs the Worker near the database, not near each visitor.

## Cost

- The org's task manager object stays awake, because it holds the chat and webhook connections.
- Each running agent is one container; an agent that is idle past the auto-sleep time in Settings stops, and its files stay in R2.

## Limits

See "Known limits" in the pull requests that added `src/cf` (SUP-1408). Local-mode sign-in does not work on Cloudflare; the Worker runs in auth mode.
