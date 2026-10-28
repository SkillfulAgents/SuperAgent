# HighLevel

Read this guide before calling HighLevel on a user's connected HighLevel
account.

## Connected Account

Available only when the system prompt lists `highlevel` as a connectable
service. Connect it with `mcp__user-input__request_connected_account`
(`toolkit: "highlevel"`), then call HighLevel API v2 through the proxy:

```text
Base: $PROXY_BASE_URL/<account_id>/services.leadconnectorhq.com
Authorization: Bearer $PROXY_TOKEN
Version: 2021-07-28
```

`<account_id>` comes from `CONNECTED_ACCOUNTS` under `highlevel`. Send the
`Version` header on every call.

One connection is one HighLevel business. HighLevel calls a business a
"location", and most endpoints take its id as `locationId` in the query or
body. Get the id once with `GET /locations/search`, which returns the
connected business's `id` and `name`. `GET /locations/{id}` returns its details.

The platform refuses every `/oauth/*` and `/marketplace/*` path.

## Endpoints

Paths and parameters follow HighLevel's API reference at
https://marketplace.gohighlevel.com/docs/. Contacts, conversations and
messages, calendars and appointments, opportunities, invoices, products,
payments, forms, surveys, social posts, and custom objects are all reachable.

## Errors

| Status | Meaning | What to do |
|---|---|---|
| `403` naming an agency login | The user connected with an agency login, which Gamut does not support | Tell the user to reconnect HighLevel as a user of one business |
| `401` from HighLevel | HighLevel refused the call. Its message says why | Tell the user which action failed and quote the message |
