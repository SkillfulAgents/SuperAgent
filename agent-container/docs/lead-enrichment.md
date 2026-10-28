# Built-In Lead Enrichment

Read this guide before matching people or enriching companies through the
Gamut platform service.

## Availability and Endpoint

This capability is available only when the system prompt advertises built-in
lead enrichment. It uses the platform's Apollo proxy and does not require the
user to create an Apollo account or supply an API key.

Use:

```text
Base: $PLATFORM_BASE_URL/v1/apollo
Authorization: Bearer $PLATFORM_AUTH_TOKEN
```

Never print either environment variable.

## The Allowlist

Only these five calls work. The allowlist is the menu; a 404 means the path
is not admitted. Do not invent an alternate endpoint or retry a denied path
with a variant.

### 1. Person match

```bash
curl -sS -X POST "$PLATFORM_BASE_URL/v1/apollo/people/match" \
  -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com"}'
```

When the work email is unknown, send `name` plus `organization_name` instead.
A no-match is a valid outcome — report it; do not invent a person.

A miss is still `200` with a `person` object. Check `person.match_confidence`:
`"none"` (with an empty `name`) means no match, even though `person.organization`
may be filled in from the email domain. Do not present that organization as the
person's employer.

### 2. Organization enrich

```text
GET /organizations/enrich?domain=
```

A miss is `200 {}` — no `organization` key at all. Test for the key before
reading fields; an empty body is a no-match, not an error.

### 3. Bulk (at most 10)

```text
POST /people/bulk_match          {"details":[...]}
POST /organizations/bulk_enrich  {"domains":[...]}
```

More than 10 records in one request returns 400. Split larger lists.

Bulk responses carry `error_code: null` on success, so the key is always
present. Treat only a non-null value as an error. Per-row misses follow the
single-call shapes above.

### 4. Search, then enrich

```text
POST /mixed_people/api_search
```

Search returns no emails or phones. Take the matches you need and call person
match or organization enrich next. Do not present search rows as enriched
contacts.

## Blocked

These are refused before the request is forwarded. Do not send them and do
not retry with a spelling variant.

- `reveal_phone_number`, `run_waterfall_phone`, and `run_waterfall_email` in
  the body or query string return 400.
- CRM writes (`/contacts`, sequences, tasks, and similar) return 404.

## Validation

- Prefer a work email. Fall back to name plus company, not a personal guess.
- Confirm that a returned person or organization is the one the user asked
  about before using it downstream.
- Report platform 400 and 404 messages accurately; they name the blocked
  field or the missing path.
