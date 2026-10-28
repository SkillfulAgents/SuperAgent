# Sanitized missing-model-price fixture

This fixture is derived from a local development transcript that contained
79,429 tokens but no embedded cost and used a discovered model absent from the
retained catalog.

It retains only the runtime model ID, token counters, message identity, and the
absence of `requestId`/`costUSD`. Prompts, responses, tool data, filesystem
paths, account data, original identifiers, and original timestamps have been
removed or replaced with synthetic values.
