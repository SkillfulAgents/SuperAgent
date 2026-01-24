# Superagent

Superagent is an open-source application for running sophisticated, code-based AI agents powered by Claude Code running in Docker containers.

## Prerequisites

- Node.js 20+
- Docker
- Anthropic API key

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the agent container:
   ```bash
   npm run build:container
   ```

3. Set up environment variables (see below)

4. Run database migrations:
   ```bash
   npm run db:migrate
   ```

5. Start the development server:
   ```bash
   npm run dev
   ```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (required) | - |
| `SUMMARIZER_MODEL` | Model used for generating session names | `claude-haiku-4-5` |

Create a `.env.local` file in the project root:

```bash
ANTHROPIC_API_KEY=your-api-key-here
# Optional overrides
# SUMMARIZER_MODEL=claude-haiku-4-5
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript type checking |
| `npm test` | Run tests in watch mode |
| `npm run test:run` | Run tests once |
| `npm run build:container` | Build the agent Docker container |
| `npm run db:migrate` | Run database migrations |
| `npm run db:generate` | Generate new migration |
| `npm run db:studio` | Open Drizzle Studio |

## Architecture

The application consists of two main parts:

1. **NextJS Application** (`/src`) - Web UI and API routes
2. **Agent Container** (`/agent-container`) - Docker container running Claude Code in headless mode

Each agent runs in its own Docker container, with communication via HTTP/WebSocket APIs.

## License

MIT
