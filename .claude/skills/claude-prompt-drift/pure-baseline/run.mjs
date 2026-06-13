// Minimal driver: invoke @anthropic-ai/claude-agent-sdk with the bare
// `claude_code` preset and nothing else (no append, no mcpServers, no custom
// tools). Sends one prompt so the SDK builds + emits its outbound /v1/messages
// payload, which the capture proxy at ANTHROPIC_BASE_URL records.
//
// The SDK version is pinned in this folder's package.json. Keep it in sync
// with SuperAgent/agent-container/package.json before running, then:
//   npm install
//   ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://localhost:9876 \
//     node run.mjs

import { query } from '@anthropic-ai/claude-agent-sdk';

const q = query({
  prompt: 'say hi',
  options: {
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    model: process.env.DRIFT_MODEL || 'claude-opus-4-7',
    permissionMode: 'bypassPermissions',
    cwd: '/tmp',
  },
});

try {
  for await (const msg of q) {
    if (msg.type === 'result') break;
  }
} catch (err) {
  console.error('[driver] expected error after capture:', err?.message ?? err);
}
