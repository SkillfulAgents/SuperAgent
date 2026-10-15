# Built-In Decisions

Read this guide before classifying, routing, checking, or scoring text or
images through the Gamut platform's OpenAI Decisions proxy.

## Availability and Endpoint

Use this capability only when the system prompt advertises built-in
decisions. The platform supplies the credentials; do not ask the user for an
OpenAI account or API key.

Use:

```text
Base: $PLATFORM_BASE_URL/v1/openai
Authorization: Bearer $PLATFORM_AUTH_TOKEN
```

Never print either environment variable. Use the supplied token unchanged; do
not substitute a vendor key or construct an acting-member token yourself.

## What You Can Call

| Call | Method | Path | Metering rate |
|---|---|---|---|
| Answer typed questions about one input | POST | `/decisions` | $0.10 per 1M input tokens |

The path is relative to the base above; do not add a second `/v1` after
`/openai`. The only model is `gpt-6-luna`; any other `model` returns `400`.

## When to Use It

Decisions returns numbers and labels, not prose. Use it when a script needs
the same small judgment many times: route each ticket, flag each photo, score
each answer. It is much faster and cheaper than generating text.

Do not use it to extract fields, write explanations, or call tools. For a
single judgment in conversation, just decide yourself.

## Request

A request has three parts:

- `model`: always `gpt-6-luna`.
- `input`: the shared evidence. A string, or user messages with
  `input_text` and `input_image` parts.
- `questions`: one or more questions, each with a unique `name`, a `type`,
  and `instructions`. Ask several questions about the same input in one
  request rather than one request per question.

Question types:

| Type | Use it to | Extra field | Main result |
|---|---|---|---|
| `predicate` | Check whether a condition is true | none | `probability` from 0 to 1 |
| `choice` | Pick one option from an unordered set | `choices`: `{value, description}` | `choice`, plus `probabilities` and `confidence` |
| `score` | Rate against ordered levels, lowest first | `levels`: `{label, description}` | `score` (weighted average of level indices from 0), plus `probabilities` and `confidence` |

```bash
curl --fail-with-body -sS \
  "$PLATFORM_BASE_URL/v1/openai/decisions" \
  -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "input": "I was charged twice for my order. Please fix this today.",
    "questions": [
      {"type": "choice", "name": "department",
       "instructions": "Which department should handle this message?",
       "choices": [
         {"value": "billing", "description": "Payments, invoices, and refunds."},
         {"value": "technical", "description": "Problems using the product."},
         {"value": "other", "description": "Anything else."}
       ]},
      {"type": "predicate", "name": "refund_requested",
       "instructions": "Does the customer ask for money back?"},
      {"type": "score", "name": "urgency",
       "instructions": "How urgent is this message?",
       "levels": [
         {"label": "Low", "description": "Can wait a week."},
         {"label": "Medium", "description": "Should be handled this week."},
         {"label": "High", "description": "Needs action today."}
       ]}
    ]
  }'
```

Include a fallback option such as `other` when the choices may not cover
every input.

## Response

`answers` has one entry per question, in an array, each carrying the
question's `name`. Match answers by `name`, not by position.

```json
{
  "model": "gpt-6-luna",
  "answers": [
    {"type": "choice", "name": "department", "choice": "billing",
     "probabilities": [{"value": "billing", "probability": 0.95}, ...],
     "confidence": 0.93},
    {"type": "predicate", "name": "refund_requested", "probability": 0.91},
    {"type": "score", "name": "urgency", "score": 1.8, "probabilities": [...],
     "confidence": 0.7}
  ],
  "usage": {"input_tokens": 310, ...}
}
```

An answer may have `"type": "refusal"` instead; handle it rather than
assuming every answer has a value. Probabilities are estimates, not
guarantees: pick a threshold for the task, and send low-confidence cases to
the user or a closer look instead of acting on them.

## Images

Images must be inline base64 data URLs in an `input_image` part. Hosted
URLs and `file_id` inputs are not supported; download the file first. The
whole request body is capped at 1,000,000 bytes, so shrink large images
(for example, to at most 1024 px on the long side, as JPEG) before encoding.

```bash
IMG="$(base64 < /workspace/photo.jpg | tr -d '\r\n')"
jq -n --arg img "data:image/jpeg;base64,$IMG" '{
  model: "gpt-6-luna",
  input: [{role: "user", content: [
    {type: "input_text", text: "Inspect the product in this photo."},
    {type: "input_image", image_url: $img}
  ]}],
  questions: [{type: "predicate", name: "visible_damage",
    instructions: "Does the product have visible damage? Ignore the packaging."}]
}' | curl --fail-with-body -sS "$PLATFORM_BASE_URL/v1/openai/decisions" \
  -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN" \
  -H "Content-Type: application/json" --data-binary @-
```

## Every Request Costs Money

Each request is metered at $0.10 per 1M input tokens from
`usage.input_tokens`; there is no output charge. Instructions, choices, and
levels count as input, so a typical text request costs well under $0.0001.
Images add more tokens. Failed requests are not charged.

Before running a batch of more than a few thousand inputs, estimate the cost
from one request's `usage.input_tokens` and tell the user. Reuse saved
answers rather than resubmitting the same input.

## Limits and Errors

- `400`: inspect the response. Fix a malformed body or a non-`gpt-6-luna`
  model. An acting-member error is a platform configuration problem; do not
  invent a member ID.
- `401` / `403`: authentication or access failed. Do not request a vendor key
  to work around platform access controls.
- `402`: platform billing access is blocked. Report the billing requirement
  rather than retrying.
- `404`: the method or path is unsupported. Do not invent alternate paths.
- `413`: the request body is over 1,000,000 bytes. Shrink images or split
  the input.
- `429`: honor `Retry-After` if provided; otherwise back off and retry once.
  Do not loop on rate limits.
- `503` with `configuration_error`: OpenAI is not configured on this proxy.
  Report the configuration error; do not ask for a key.
- Decisions is in public beta; if OpenAI returns a schema error for a field
  shown here, report the error rather than guessing new fields.
