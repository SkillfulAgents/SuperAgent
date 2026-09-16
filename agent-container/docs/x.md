# Built-In X (Twitter) Reads

Read this guide before searching or reading X posts or profiles through the
Gamut platform service.

## Availability and Endpoint

This capability is available only when the system prompt advertises built-in
X reads. It uses the platform's X-compatible proxy and does not require the
user to have an X account or an X API key.

Use:

```text
Base: $ANTHROPIC_BASE_URL/v1/x
Authorization: Bearer $ANTHROPIC_AUTH_TOKEN
```

Never print either environment variable.

## What You Can Call

All calls are `GET`. Paths are X API v2 paths under the base above. Nothing
outside this list works; the platform returns `404` before contacting X.

| Call | Path | Cost |
|---|---|---|
| Search recent posts (last 7 days) | `/2/tweets/search/recent?query=...&max_results=10..100` | $0.005 per post returned |
| Look up posts by id | `/2/tweets?ids=...` or `/2/tweets/{id}` | $0.005 per post |
| Count matching posts | `/2/tweets/counts/recent?query=...` | $0.005 per request |
| Look up users | `/2/users/by/username/{username}`, `/2/users/by?usernames=...`, `/2/users/{id}`, `/2/users?ids=...` | $0.010 per user |
| A user's recent posts | `/2/users/{id}/tweets` or `/2/users/by/username/{username}/tweets` | $0.005 per post |
| Mentions of a user | `/2/users/{id}/mentions` | $0.005 per post |
| Followers or following | `/2/users/{id}/followers`, `/2/users/{id}/following` | $0.010 per user, at most 100 per call |

Example:

```bash
curl -sS "$ANTHROPIC_BASE_URL/v1/x/2/tweets/search/recent?query=gamut%20agents&max_results=10&tweet.fields=created_at,public_metrics" \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN"
```

## Every Result Costs Money

The platform bills every post and every user object X returns, including the
user objects in `includes.users`. Keep the bill to what the task needs:

- Set `max_results` to the number you will actually read. Post endpoints default to 10; followers and following default to 100 (the platform caps them at 100).
- Omit `expansions` unless you need author names. `expansions=author_id`
  adds one billed user per distinct author.
- Request only the fields you will use with `tweet.fields` and `user.fields`.
- Search covers the last 7 days only. There is no full-archive search.

## Rate Limits

X limits requests per 15 minutes and the limit is shared across the whole
platform. On `429`, read `x-rate-limit-reset` (epoch seconds), wait until
then, and retry once. Do not loop on `429`.

## Errors

- `404`: the path is not on the list above. Do not invent alternate paths.
- `503`: the platform's X access is not configured or its credits are
  exhausted. Tell the user the capability is unavailable right now.
- `429`: see Rate Limits.

## Attribution

Quote posts with the author's username and a link of the form
`https://x.com/{username}/status/{id}` when presenting them to the user.
