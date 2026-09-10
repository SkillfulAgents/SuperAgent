# X (Twitter)

Read this guide before searching or reading X posts or profiles through the
Gamut platform service, or before calling X on a user's connected X account.

## Which X Capability to Use

- Public data and no X account connected: use the built-in reads. Do not ask
  the user to connect.
- The user's own data or any write: use the connected account, when the
  system prompt advertises X connected accounts. Ask to connect if none exists.
  When it does not, tell the user the task needs an X account this host cannot
  connect.
- An X account already connected: use it for everything, public reads
  included. Its rate limit is per user rather than shared.

Never print any of the environment variables named below.

## Built-In Reads

Available only when the system prompt advertises built-in X reads. Uses the
platform's X-compatible proxy and does not require the user to have an X
account or an X API key.

```text
Base: $ANTHROPIC_BASE_URL/v1/x
Authorization: Bearer $ANTHROPIC_AUTH_TOKEN
```

Never print either environment variable.

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

Search covers the last 7 days only. There is no full-archive search.

## Connected Account

Available only when the system prompt lists `twitter` as a connectable
service. Connect it with `mcp__user-input__request_connected_account`
(`toolkit: "twitter"`), then call the X API v2 through the proxy:

```text
Base: $PROXY_BASE_URL/<account_id>/api.x.com
Authorization: Bearer $PROXY_TOKEN
```

`<account_id>` comes from `CONNECTED_ACCOUNTS` under `twitter`.

Paths are X API v2 paths under the base above. Nothing outside this list works;
the platform returns `404` before contacting X. Reads bill per object X
returns, including objects in `includes`. Writes bill per request.

| Call | Paths | Cost |
|---|---|---|
| The connected user | `GET /2/users/me` | $0.010 per user |
| Look up users | `GET /2/users`, `/2/users/{id}`, `/2/users/by`, `/2/users/by/username/{username}`, `/2/users/search`, `/2/users/{id}/affiliates` | $0.010 per user |
| Who reposted or liked a post | `GET /2/tweets/{id}/retweeted_by`, `/2/tweets/{id}/liking_users` | $0.010 per user |
| Followers or following | `GET /2/users/{id}/followers`, `/2/users/{id}/following` | $0.010 per user, at most 100 per call |
| Read posts | `GET /2/tweets`, `/2/tweets/{id}`, `/2/tweets/search/recent`, `/2/tweets/{id}/quote_tweets`, `/2/tweets/{id}/retweets`, `/2/users/{id}/tweets`, `/2/users/by/username/{username}/tweets`, `/2/users/{id}/mentions`, `/2/users/reposts_of_me`, `/2/users/{id}/liked_tweets` | $0.005 per post |
| Home timeline | `GET /2/users/{id}/timelines/reverse_chronological` | $0.005 per post |
| Bookmarks | `GET /2/users/{id}/bookmarks`, `/2/users/{id}/bookmarks/folders/{folder_id}` | $0.005 per post |
| Bookmark folders | `GET /2/users/{id}/bookmarks/folders` | $0.005 per request |
| Count matching posts | `GET /2/tweets/counts/recent` | $0.005 per request |
| Read direct messages | `GET /2/dm_events`, `/2/dm_events/{id}`, `/2/dm_conversations/{id}/dm_events`, `/2/dm_conversations/with/{user_id}/dm_events` | $0.010 per event |
| Lists | `GET /2/lists/{id}`, `/2/users/{id}/owned_lists`, `/2/users/{id}/followed_lists`, `/2/users/{id}/list_memberships`, `/2/users/{id}/pinned_lists` | $0.005 per list |
| Posts in a list | `GET /2/lists/{id}/tweets` | $0.005 per post |
| List members or followers | `GET /2/lists/{id}/members`, `/2/lists/{id}/followers` | $0.010 per user |
| Spaces | `GET /2/spaces`, `/2/spaces/{id}`, `/2/spaces/by/creator_ids`, `/2/spaces/search` | $0.005 per Space |
| Posts shared in a Space | `GET /2/spaces/{id}/tweets` | $0.005 per post |
| Communities | `GET /2/communities/{id}`, `/2/communities/search` | $0.005 per community |
| Muted or blocked accounts | `GET /2/users/{id}/muting`, `/2/users/{id}/blocking` | $0.001 per user |
| Trends | `GET /2/trends/by/woeid/{woeid}`, `/2/users/personalized_trends` | $0.010 per request |
| News | `GET /2/news/search`, `/2/news/{id}` | no charge today |
| Media lookup | `GET /2/media`, `/2/media/{media_key}` | no charge today |
| Post | `POST /2/tweets` | $0.015, or $0.200 when the text contains a URL |
| Delete a post | `DELETE /2/tweets/{id}` | $0.010 |
| Repost | `POST /2/users/{id}/retweets` | $0.015 |
| Undo a repost | `DELETE /2/users/{id}/retweets/{tweet_id}` | $0.010 |
| Like | `POST /2/users/{id}/likes` | $0.015 |
| Unlike | `DELETE /2/users/{id}/likes/{tweet_id}` | $0.010 |
| Follow | `POST /2/users/{id}/following` | $0.015 |
| Unfollow | `DELETE /2/users/{id}/following/{target_id}` | $0.010 |
| Mute | `POST /2/users/{id}/muting` | $0.015 |
| Unmute | `DELETE /2/users/{id}/muting/{target_id}` | $0.005 |
| Bookmark | `POST /2/users/{id}/bookmarks`, `POST /2/users/{id}/bookmarks/folders`, `DELETE /2/users/{id}/bookmarks/{tweet_id}` | $0.005 |
| Send a direct message | `POST /2/dm_conversations`, `/2/dm_conversations/with/{user_id}/messages`, `/2/dm_conversations/{id}/messages` | $0.015 |
| Delete a direct message | `DELETE /2/dm_events/{id}` | $0.010 |
| Create a list | `POST /2/lists` | $0.010 |
| Manage a list | `PUT /2/lists/{id}`, `DELETE /2/lists/{id}`, `POST /2/lists/{id}/members`, `DELETE /2/lists/{id}/members/{user_id}`, `POST /2/users/{id}/followed_lists`, `DELETE /2/users/{id}/followed_lists/{list_id}`, `POST /2/users/{id}/pinned_lists`, `DELETE /2/users/{id}/pinned_lists/{list_id}` | $0.005 |
| Upload media | `POST /2/media/upload/initialize`, `/2/media/upload/{id}/append`, `/2/media/upload/{id}/finalize`, `GET /2/media/upload`, `POST /2/media/upload` | no charge today |
| Media alt text | `POST /2/media/metadata` | $0.005 |

Example:

```bash
curl -sS "$PROXY_BASE_URL/$ACCOUNT_ID/api.x.com/2/users/me?user.fields=public_metrics" \
  -H "Authorization: Bearer $PROXY_TOKEN"
```

### Uploading Media

Send JSON only. Multipart bodies are refused with `415`, and a single request
over the proxy's size cap is refused with `413`. Upload in chunks of at most
512 KB of file bytes per segment:

1. `POST /2/media/upload/initialize` with `{"media_type": "image/png", "total_bytes": <size>, "media_category": "tweet_image"}`. The response carries `data.id`.
2. For each chunk, `POST /2/media/upload/{id}/append` with `{"segment_index": <n>, "media": "<base64 of the chunk>"}`, starting at 0.
3. `POST /2/media/upload/{id}/finalize`. For video, poll `GET /2/media/upload?command=STATUS&media_id={id}` until `processing_info.state` is `succeeded`.
4. Post with `{"text": "...", "media": {"media_ids": ["{id}"]}}`, or set alt text first with `POST /2/media/metadata`.

`POST /2/media/upload` uploads a whole file in one request. It fits only small
files, so prefer the chunked form.

## Every Call Costs Money

The platform bills every post and every user object X returns, including the
user objects in `includes.users`, and every write request. Keep the bill to
what the task needs:

- Set `max_results` to the number you will actually read. Post endpoints default to 10; followers and following default to 100 (the platform caps them at 100).
- Omit `expansions` unless you need author names. `expansions=author_id`
  adds one billed user per distinct author.
- Request only the fields you will use with `tweet.fields` and `user.fields`.
- Before followers or following, tell the user it is $0.010 per person, up to
  $1 per page, and get an OK.
- A post whose text contains a URL costs $0.200 instead of $0.015. Tell the
  user the price and get an OK before posting a link.

## Rate Limits

X limits requests per 15 minutes. The built-in reads share one limit across
the whole platform. A connected account has its own limit per user. On `429`,
read `x-rate-limit-reset` (epoch seconds), wait until then, and retry once. Do
not loop on `429`.

## Errors

- `404`: the path is not on the list for that capability. Do not invent
  alternate paths.
- `402` (connected account): the workspace has no balance for platform
  services. Tell the user to top up; the X account itself is fine.
- `413` (connected account): the request body is over the proxy's cap. For
  media, use the chunked upload with smaller segments.
- `403` with `account_reauth_dismissed` (connected account): the user declined
  to reconnect the account. Do not retry until they reconnect it.
- `503` (built-in reads): the platform's X access is not configured or its
  credits are exhausted. Tell the user the capability is unavailable right now.
- `429`: see Rate Limits.

## Attribution

Quote posts with the author's username and a link of the form
`https://x.com/{username}/status/{id}` when presenting them to the user.
