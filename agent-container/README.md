# Superagent Container

Docker container running Claude Code with HTTP/WebSocket API for the Superagent application.

## Architecture

The container runs a Node.js/TypeScript server (using Hono) that manages Claude Code sessions. Each session spawns a separate Claude Code process in headless mode, allowing multiple agents to run simultaneously.

## Building the Container

```bash
docker build -t superagent-container .
```

## Running the Container

```bash
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=your_api_key \
  superagent-container
```

### Environment Variables

- `PORT` - Server port (default: 3000)
- `ANTHROPIC_API_KEY` - Your Anthropic API key
- `ANTHROPIC_BASE_URL` - Custom API base URL (optional)

## API Reference

### Sessions

#### Create Session
```http
POST /sessions
Content-Type: application/json

{
  "metadata": { "name": "My Agent" },
  "workingDirectory": "/workspace/custom",
  "envVars": {
    "ANTHROPIC_API_KEY": "sk-..."
  }
}
```

Response:
```json
{
  "id": "uuid",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "lastActivity": "2024-01-01T00:00:00.000Z",
  "metadata": { "name": "My Agent" },
  "workingDirectory": "/workspace/uuid"
}
```

#### Get Session
```http
GET /sessions/:id
```

#### List All Sessions
```http
GET /sessions
```

#### Delete Session
```http
DELETE /sessions/:id
```

### Messages

#### Get All Messages
```http
GET /sessions/:id/messages
```

#### Send Message
```http
POST /sessions/:id/messages
Content-Type: application/json

{
  "type": "user",
  "content": "Write a hello world function"
}
```

### WebSocket Streaming

Connect to a session for real-time streaming:

```javascript
const ws = new WebSocket('ws://localhost:3000/sessions/:id/stream');

ws.on('message', (data) => {
  const event = JSON.parse(data);
  console.log(event);
});

// Send messages
ws.send(JSON.stringify({
  type: 'user',
  content: 'Your message here'
}));
```

Event types:
- `message` - Assistant response or message
- `status` - Status update
- `error` - Error occurred

### File System API

#### Browse Directory/Get File Info
```http
GET /files/path/to/dir
```

#### Get File Content
```http
GET /files/path/to/file.txt/content
```

#### Upload File
```http
POST /files/path/to/file.txt/upload
Content-Type: text/plain

file content here
```

#### Delete File/Directory
```http
DELETE /files/path/to/file
```

#### Create Directory
```http
POST /files/path/to/dir/mkdir
```

#### Get File Tree
```http
GET /files/tree?depth=3&path=subdir
```

## Development

### Install Dependencies
```bash
npm install
```

### Run in Development Mode
```bash
npm run dev
```

### Build TypeScript
```bash
npm run build
```

### Start Production Server
```bash
npm start
```

## Project Structure

```
agent-container/
├── src/
│   ├── server.ts           # Main Hono server with REST & WebSocket
│   ├── session-manager.ts  # Session management logic
│   ├── claude-code.ts      # Claude Code process wrapper
│   └── types.ts           # TypeScript interfaces
├── Dockerfile
├── package.json
└── tsconfig.json
```

## How It Works

1. **Session Creation**: When a session is created, a new Claude Code process is spawned with its own working directory
2. **Message Handling**: Messages are sent to the Claude Code process via stdin as JSON
3. **Response Streaming**: Claude Code outputs are parsed from stdout and streamed to WebSocket clients
4. **File System**: All sessions share the `/workspace` directory with isolated subdirectories per session

## Notes

- Each session runs an independent Claude Code instance
- Sessions persist until explicitly deleted
- WebSocket connections allow real-time streaming of responses
- File system operations are scoped to `/workspace` for security
