# Sanitized runtime-model usage fixtures

These JSONL rows are derived from local development transcripts that reproduced
zero-cost usage and inflated token totals.

The fixtures retain only the fields needed by the usage calculator: runtime
model IDs, token counters, speed tier, message identity, and the presence or
absence of `requestId`/`costUSD`. Prompts, responses, thinking, signatures, tool
inputs/results, filesystem paths, account data, original UUIDs, and original
timestamps have been removed or replaced with synthetic values.
