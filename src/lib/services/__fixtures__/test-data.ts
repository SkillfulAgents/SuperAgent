/**
 * Test fixtures based on real data from ~/.superagent/
 */

// Sample CLAUDE.md content
export const SAMPLE_CLAUDE_MD = `---
name: Github Agent
createdAt: "2026-01-24T01:30:50.090Z"
description: An agent that helps with GitHub tasks
---

# Agent Instructions

You are a helpful AI assistant.

## Preferences

<!-- The agent can learn and note preferences here -->

## Project Notes

<!-- The agent can add notes as it learns about the project -->
`

export const SAMPLE_CLAUDE_MD_MINIMAL = `---
name: Minimal Agent
createdAt: "2026-01-20T00:00:00.000Z"
---

Basic instructions here.
`

export const SAMPLE_CLAUDE_MD_NO_FRONTMATTER = `# Just Instructions

No frontmatter in this file.
`

// Sample .env file content
export const SAMPLE_ENV_FILE = `# Superagent Secrets
# Format: ENV_VAR=value  # Display Name

GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx  # GitHub Token
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx  # OpenAI API Key
SIMPLE_KEY=simplevalue
QUOTED_VALUE="value with spaces"
`

export const SAMPLE_ENV_FILE_WITH_SPECIAL_CHARS = `# Superagent Secrets
API_KEY="key=with=equals"  # API Key
URL="https://example.com?foo=bar#anchor"  # URL With Hash
MULTILINE="line1\\nline2"  # Multiline Value
`

// Sample session-metadata.json content
export const SAMPLE_SESSION_METADATA = {
  '519f8756-a16e-41ff-99de-9fe599dedae5': {
    name: 'Simple Math Question',
    createdAt: '2026-01-24T01:30:58.665Z',
  },
  'cb5e37e3-0e79-4aaa-86ad-813d9376056a': {
    name: 'List DatawizzAI Organization Repos',
    createdAt: '2026-01-24T03:03:38.038Z',
  },
}

// Sample JSONL session entries
export const SAMPLE_JSONL_ENTRIES = [
  {
    type: 'user',
    parentUuid: null,
    sessionId: '519f8756-a16e-41ff-99de-9fe599dedae5',
    uuid: 'f6f8a4a3-97cd-47a2-9f4f-997dce7e920f',
    timestamp: '2026-01-24T01:30:58.661Z',
    message: {
      role: 'user',
      content: 'Whats 1+1?',
    },
  },
  {
    type: 'assistant',
    parentUuid: 'f6f8a4a3-97cd-47a2-9f4f-997dce7e920f',
    sessionId: '519f8756-a16e-41ff-99de-9fe599dedae5',
    uuid: '54d90a93-bd03-4b57-9e0a-57e8faead206',
    timestamp: '2026-01-24T01:31:00.903Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '1 + 1 = 2' }],
    },
  },
  {
    type: 'user',
    parentUuid: '54d90a93-bd03-4b57-9e0a-57e8faead206',
    sessionId: '519f8756-a16e-41ff-99de-9fe599dedae5',
    uuid: '823bdc94-1f9c-4cdc-b4da-40d59dd238b6',
    timestamp: '2026-01-24T01:31:09.942Z',
    message: {
      role: 'user',
      content: 'What defines the + operator?',
    },
  },
  {
    type: 'assistant',
    parentUuid: '823bdc94-1f9c-4cdc-b4da-40d59dd238b6',
    sessionId: '519f8756-a16e-41ff-99de-9fe599dedae5',
    uuid: 'f73b2202-1e5a-44cf-b54b-9c7c48735c84',
    timestamp: '2026-01-24T01:31:19.827Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'The `+` operator is defined by **mathematics**...' }],
    },
  },
]

// Sample JSONL with tool use
export const SAMPLE_JSONL_WITH_TOOL_USE = [
  {
    type: 'user',
    parentUuid: null,
    sessionId: 'tool-session-123',
    uuid: 'user-msg-1',
    timestamp: '2026-01-24T10:00:00.000Z',
    message: {
      role: 'user',
      content: 'List the files in /workspace',
    },
  },
  {
    type: 'assistant',
    parentUuid: 'user-msg-1',
    sessionId: 'tool-session-123',
    uuid: 'assistant-msg-1',
    timestamp: '2026-01-24T10:00:01.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll list the files for you." },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'ls /workspace' },
        },
      ],
    },
  },
  {
    type: 'user',
    parentUuid: 'assistant-msg-1',
    sessionId: 'tool-session-123',
    uuid: 'tool-result-1',
    timestamp: '2026-01-24T10:00:02.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'file1.txt\nfile2.txt\nREADME.md',
        },
      ],
    },
    toolUseResult: {
      stdout: 'file1.txt\nfile2.txt\nREADME.md',
      stderr: '',
      interrupted: false,
      isImage: false,
    },
  },
  {
    type: 'assistant',
    parentUuid: 'tool-result-1',
    sessionId: 'tool-session-123',
    uuid: 'assistant-msg-2',
    timestamp: '2026-01-24T10:00:03.000Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'The workspace contains: file1.txt, file2.txt, and README.md',
        },
      ],
    },
  },
]

// Helper to convert entries to JSONL string
export function toJsonl(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n')
}
