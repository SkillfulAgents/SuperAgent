# LLM API (Anthropic SDK)

Dashboards have built-in access to Claude via an [Anthropic SDK](https://docs.anthropic.com/en/api/messages)-compatible client. No API keys or setup required — calls route through the user's configured LLM provider automatically.

The API is compatible with the official `@anthropic-ai/sdk` JavaScript SDK. Any examples or documentation for the Anthropic SDK will work here.

## Quick Start

```javascript
const client = new Anthropic();

// Simple message
const message = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Summarize this data in 2 sentences.' }]
});

console.log(message.content[0].text);
```

## Streaming

For real-time text output, use `.stream()`:

```javascript
const client = new Anthropic();

const stream = client.messages.stream({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Write a haiku about dashboards.' }]
});

stream.on('text', (delta, fullText) => {
  document.getElementById('output').textContent = fullText;
});

stream.on('end', () => {
  console.log('Done!');
});
```

Or using `for await`:

```javascript
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true
});

for await (const event of response) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

## API Reference

### `new Anthropic(options?)`

Creates a new client instance.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | string | `'claude-sonnet-4-6'` | Default model for all requests (can be overridden per-call) |

### `client.messages.create(params)`

Create a message (non-streaming or streaming).

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | No | Model to use (defaults to client's default) |
| `max_tokens` | number | Yes | Maximum tokens to generate |
| `messages` | array | Yes | Conversation messages `[{ role, content }]` |
| `system` | string | No | System prompt |
| `temperature` | number | No | Sampling temperature (0-1) |
| `stream` | boolean | No | If `true`, returns an async iterable of SSE events |

**Returns:**
- Without `stream`: `Promise<Message>` — the full message response
- With `stream: true`: `Promise<AsyncIterable<StreamEvent>>` — yields raw stream events

**Message response shape:**
```javascript
{
  id: "msg_...",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "..." }],
  model: "claude-sonnet-4-6",
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 50 }
}
```

### `client.messages.stream(params)`

Create a streaming message with a higher-level event-driven interface.

Takes the same parameters as `create()` (except `stream` is set automatically).

**Returns:** `MessageStream`

### `MessageStream`

| Method | Description |
|--------|-------------|
| `.on(event, callback)` | Subscribe to events. Returns `this` for chaining. |
| `.off(event, callback)` | Unsubscribe from an event. |
| `.finalMessage()` | Returns `Promise<Message>` — resolves when stream completes. |
| `.finalText()` | Returns `Promise<string>` — resolves with the full concatenated text. |
| `.abort()` | Abort the stream. |
| `[Symbol.asyncIterator]` | Yields raw `StreamEvent` objects (for `for await`). |

**Events:**

| Event | Callback signature | Description |
|-------|-------------------|-------------|
| `'text'` | `(deltaText, fullTextSoFar)` | Fired on each text chunk. |
| `'message'` | `(message)` | Fired when the full message is complete. |
| `'error'` | `(error)` | Fired on any error. |
| `'end'` | `()` | Fired when the stream ends. |

## Models

The default model is `claude-sonnet-4-6` (good balance of speed and capability). You can use any model your provider supports:

| Model | Best for |
|-------|----------|
| `claude-haiku-4-5` | Fast, cheap — autocomplete, classification, simple Q&A |
| `claude-sonnet-4-6` | Balanced — most dashboard use cases (default) |
| `claude-opus-4-7` | Most capable — complex reasoning, analysis |

## Examples

### Chat Widget

```javascript
const client = new Anthropic();
const history = [];

async function sendMessage(userText) {
  history.push({ role: 'user', content: userText });

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are a helpful assistant for this dashboard.',
    messages: history
  });

  let response = '';
  stream.on('text', (delta, full) => {
    response = full;
    renderAssistantMessage(full);
  });

  await stream.finalMessage();
  history.push({ role: 'assistant', content: response });
}
```

### Data Analysis

```javascript
const client = new Anthropic();

async function analyzeData(data) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Analyze this data and give 3 key insights:\n\n${JSON.stringify(data)}`
    }]
  });
  return message.content[0].text;
}
```

### Autocomplete / Suggestions

```javascript
const client = new Anthropic();

async function getSuggestions(input) {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5',  // Fast model for autocomplete
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Complete this search query with 3 suggestions (JSON array): "${input}"`
    }]
  });
  return JSON.parse(message.content[0].text);
}
```

## Error Handling

```javascript
try {
  const message = await client.messages.create({ ... });
} catch (err) {
  // err.message contains the error description
  // Common errors:
  // - "LLM provider not configured" — no API key set in Superagent settings
  // - "Too many LLM requests" — rate limited (20 req/min)
  // - Upstream API errors (429 rate limit, 400 invalid params, etc.)
  console.error('LLM error:', err.message);
}
```

For streaming:
```javascript
const stream = client.messages.stream({ ... });
stream.on('error', (err) => {
  console.error('Stream error:', err.message);
});
```

## Notes

- The API is automatically available in all dashboards — no imports or setup required.
- Under the hood, this is the real `@anthropic-ai/sdk` — all features work (tool use, vision, extended thinking, etc.).
- The SDK is lazy-loaded on first use. The first call may have a small delay while the SDK loads; subsequent calls are instant.
- Calls are rate-limited to 100 requests per minute to prevent runaway loops.
- Search for "Anthropic JavaScript SDK" for more examples and patterns — the API is fully compatible.
- `window.Anthropic` is available globally.
- If you need the model to have context about your dashboard or the user's data, pass it in the `system` prompt or as part of the `messages`.
