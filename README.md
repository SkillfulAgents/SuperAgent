# Superagent

Superagent is an open-source application for running sophisticated, code-based AI agents powered by Claude Code running in Docker containers. It supports both web browser and Electron desktop deployments.

## Prerequisites

- Node.js 20+
- Docker or Podman
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

### Development
| Script | Description |
|--------|-------------|
| `npm run dev` | Start web app + API server in parallel |
| `npm run dev:api` | Start API server only (port 3001) |
| `npm run dev:web` | Start Vite dev server only (port 3000) |
| `npm run dev:electron` | Start Electron app in development |

### Build
| Script | Description |
|--------|-------------|
| `npm run build` | Build web app + API for production |
| `npm run build:web` | Build web frontend only |
| `npm run build:api` | Build API server only |
| `npm run build:electron` | Build Electron app |
| `npm run build:container` | Build the agent Docker container |

### Distribution
| Script | Description |
|--------|-------------|
| `npm run dist:mac` | Package Electron app for macOS |
| `npm run dist:win` | Package Electron app for Windows |
| `npm run preview` | Build and run production server locally |

### Quality
| Script | Description |
|--------|-------------|
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm test` | Run tests in watch mode |
| `npm run test:run` | Run tests once |
| `npm run test:coverage` | Run tests with coverage |

### Database
| Script | Description |
|--------|-------------|
| `npm run db:migrate` | Run database migrations |
| `npm run db:generate` | Generate new migration |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run db:reset` | Reset database |

## Project Structure

```
superagent/
├── src/
│   ├── api/                    # Hono API routes
│   │   ├── index.ts            # Main Hono app with route mounting
│   │   └── routes/
│   │       ├── agents.ts       # Agent CRUD, sessions, secrets, skills
│   │       ├── sessions.ts     # Session management, SSE streaming
│   │       ├── connected-accounts.ts  # OAuth flows
│   │       ├── settings.ts     # Global settings
│   │       └── providers.ts    # OAuth providers
│   │
│   ├── web/                    # Node.js web server entry
│   │   └── server.ts           # Production server with static file serving
│   │
│   ├── main/                   # Electron main process
│   │   └── index.ts            # Window creation, API server, protocol handling
│   │
│   ├── preload/                # Electron preload scripts
│   │   └── index.ts            # IPC bridge for renderer
│   │
│   ├── renderer/               # React frontend (shared between web & Electron)
│   │   ├── index.html          # HTML entry point
│   │   ├── main.tsx            # React entry point
│   │   ├── App.tsx             # Root React component
│   │   ├── globals.css         # Global styles and CSS variables
│   │   ├── components/         # React components
│   │   │   ├── agents/         # Agent management UI
│   │   │   ├── sessions/       # Session list and dialogs
│   │   │   ├── messages/       # Message display and input
│   │   │   ├── settings/       # Settings dialogs
│   │   │   ├── layout/         # App sidebar and main content
│   │   │   └── ui/             # Reusable UI primitives (shadcn)
│   │   ├── hooks/              # React Query hooks for data fetching
│   │   ├── providers/          # React context providers
│   │   ├── context/            # React contexts
│   │   └── lib/                # Frontend utilities
│   │       └── env.ts          # Environment detection (web vs Electron)
│   │
│   └── shared/                 # Shared code (used by API and services)
│       └── lib/
│           ├── services/       # Business logic (agents, sessions, secrets)
│           ├── container/      # Docker/Podman container management
│           ├── db/             # Database schema and migrations
│           ├── config/         # Settings and configuration
│           ├── composio/       # Composio OAuth integration
│           ├── skills/         # Agent skills registry
│           ├── types/          # TypeScript type definitions
│           └── utils/          # Utility functions
│
├── agent-container/            # Docker container for running Claude Code
│   ├── Dockerfile
│   ├── src/                    # Container server code
│   └── package.json
│
├── vite.config.ts              # Vite config for web builds
├── electron.vite.config.ts     # electron-vite config for Electron builds
├── tailwind.config.ts          # Tailwind CSS configuration
├── tsconfig.json               # TypeScript configuration
└── drizzle.config.ts           # Drizzle ORM configuration
```

## Architecture

The application uses a dual-target architecture supporting both web and Electron desktop deployment:

### Web Mode
- **Frontend**: Vite dev server (port 3000) proxies API requests to the backend
- **Backend**: Hono server (port 3001) handles API routes and serves static files in production

### Electron Mode
- **Main Process**: Starts embedded Hono API server and creates browser window
- **Renderer Process**: Same React app as web, communicates with API via localhost
- **Preload Script**: Exposes safe IPC methods to renderer

### Agent Containers
Each agent runs in its own Docker/Podman container with Claude Code in headless mode:
- Containers communicate via HTTP/WebSocket APIs
- SSE streaming for real-time message updates
- File-based persistence for agents, sessions, and messages
- SQLite database for OAuth connected accounts

## Technology Stack

- **Frontend**: React 18, TanStack Query, Tailwind CSS, Radix UI
- **Backend**: Hono (lightweight web framework)
- **Build**: Vite, electron-vite, tsup
- **Desktop**: Electron
- **Database**: SQLite (better-sqlite3), Drizzle ORM
- **Containers**: Docker/Podman
- **AI**: Anthropic Claude API

## License

MIT
