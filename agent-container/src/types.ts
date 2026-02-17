// Re-export types from Claude Agent SDK
export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKCompactBoundaryMessage,
  Query,
  Options,
} from '@anthropic-ai/claude-agent-sdk';

// Custom types for our container
export interface Session {
  id: string;
  createdAt: Date;
  lastActivity: Date;
  metadata?: Record<string, any>;
  workingDirectory: string;
  envVars?: Record<string, string>;
  systemPrompt?: string;
  availableEnvVars?: string[];
}

export interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: Date;
}

export interface FileTree {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTree[];
}

export interface CreateSessionRequest {
  metadata?: Record<string, any>;
  workingDirectory?: string;
  envVars?: Record<string, string>;
  systemPrompt?: string; // Custom system prompt to append to default
  availableEnvVars?: string[]; // List of env var names available to the agent
  initialMessage: string; // Required: first message to send (triggers session ID generation)
  model?: string; // Claude model to use for this session
  browserModel?: string; // Model for browser subagent
}

export interface SendMessageRequest {
  content: any;
  type?: 'user' | 'system';
}
