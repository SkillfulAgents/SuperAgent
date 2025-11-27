# Super Agent

Super Agent is an open-source application that allows users to run sophisticated, code based AI agents. The one thing AI models are already pretty good at is agentically writing code. Thankfully, many general purpose tasks can be reduced into code wrriting tasks. Super Agent leverages this with general purpose code based agents.

The agents are powered by Claude Code itself, running in headless mode inside a docker container where it can run wild. The docker container exposes an API that the Super Agent can send messages to and get responses from, including a websocket interface for streaming responses.

The Super Agent application itself is a NextJS application that provides a user interface for managing agents, creating new agents, and running them. It uses a SQLite database to store agent configurations, message histories, and other data.

## Architecture

The codebase will generly be split into two main parts:
1. The NextJS application code, which handles the user interface, API routes, and database interactions.
  - This code will live in `/app`.
2. The Docker container running Claude Code, which handles the AI model interactions and exposes an API for the NextJS application to communicate with.
  - This code will live in `/agent-container`.

### The NextJS Application

The next application will be built using TypeScript and will leverage various libraries for state management, UI components, and database interactions. We will build it as a static SPA, using client queries to fetch data from the API routes.
The API routes will handle all interactions with the SQLite database, including CRUD operations for agents, messages, and other data.

The main screen of the application will be split in two:
- A sidebar on the left, which will list all the agents and provide options to create new agents.
    - Next to each agent in the list there'll be an indicator showing the agent's current status (spinning if currently running, notification if there are new messages the user hasn't seen yet, grey if idle, etc).
- A main content area on the right, which will display the currently selected agent's details, message history, and an input section in the bottom to send new messages to the agent. 
    - While an agent is pulled up, the main content area will stream in responses from the agent in real-time, showing the user what the agent is thinking as it generates its response.

Each agent will have a seperate docker container running Claude Code, which the NextJS application will communicate with via HTTP and Websockets. So when a new agent is created, the NextJS application will spin up a new docker container instance for that agent. 

We should have a common interface for communicating with the docker container. There'll be multiple implementations of this interface (the first one we'll create runs the docker container locally, but in the future we could have implementations that run the container in the cloud, or on a remote server). So we should have a `ContainerClient` interface that defines methods for sending messages to the container, receiving responses, subscribing to streams and managing the container's lifecycle. It should also maintain the current state of the container (running, stopped, error, etc). When a user sends a message to a stopped container, the application should automatically start the container before sending the message.

When initializing the container, we should also be able to pass in some initial env variable - like Anthropic Base URL and API Keys.

Our first implementation will have a `LocalDockerContainerClient` class that implements the `ContainerClient` interface and manages a local docker container instance using the Docker CLI. This class will handle starting, stopping, and communicating with the container. It should have a const name for the docker image to use (e.g. `superagent-container:latest`). When we initilze the app, it'll check if the image is already built locally, and if not it'll build it using the Dockerfile in the `/agent-container` folder (forward logs to the console so the user can see build progress).

Whereather the container is running, the app will initialize sessions, send messages and receive responses using the API exposed by the container. It'll save messages to the database as they are sent and received, and stream updates to the UI in real-time using websockets.

For the datalayer - we will use an embedded SQLite database to store all agent configurations, message histories, and other data. We can use an ORM like Prisma or TypeORM to interact with the database in a type-safe manner. We will have a `migrations` folder to store database migration scripts, and we will set up a simple migration system to apply migrations when the application starts. There should be a mechanism to remember which migrations have already been applied, so we don't apply the same migration multiple times.

Agents and Session - each agent will have a unique ID and will corrospond to a running docker container instance. Within each agent, we can have multiple sessions - each session represents a conversation with the agent. Each session will have its own message history, and the user can switch between sessions for the same agent.

#### Tech Stack
- NextJS with TypeScript
- SQLite with an ORM (Prisma or TypeORM)
- Docker CLI for managing container instances
- Shadcn/ui for UI components
- Tailwind CSS for styling
- Tanstack Query for data fetching and state management



### The Docker Container
The docker container will run Claude Code in headless mode, exposing an HTTP API and a Websocket API for communication. We will create a `ContainerClient` class in the NextJS application that implements the interface mentioned earlier, handling all interactions with the docker container.

The system will use Claude Code's streaming JSON input/output capabilities for real-time communication, with a Node.js server managing sessions and WebSocket connections for streaming. Use TypeScript and Hono for the server running inside the container. 

#### API Design

```typescript
// API Schema
interface Session {
  id: string;
  createdAt: Date;
  lastActivity: Date;
  metadata?: Record<string, any>;
}

interface Message {
  type: 'user' | 'assistant' | 'system' | 'init' | 'result';
  content: any;
  timestamp: Date;
  sessionId: string;
}

// REST Endpoints
POST   /sessions                 // Create new session
GET    /sessions/:id             // Get session info
GET    /sessions/:id/messages    // Get all messages from session
POST   /sessions/:id/messages    // Send message to session
DELETE /sessions/:id             // End session

// File System API
GET    /files/*                 // Browse directory or get file info
GET    /files/*/content         // Download file content
POST   /files/*/upload          // Upload file to path
DELETE /files/*                 // Delete file or directory
POST   /files/*/mkdir           // Create directory
GET    /files/tree              // Get file tree (with depth limit)

// WebSocket endpoint for streaming
WS     /sessions/:id/stream      // Subscribe to session updates
```

#### Rough Docker Container Setup

```Dockerfile
FROM ubuntu:22.04

# Install Claude Code CLI
RUN apt-get update && apt-get install -y \
    curl \
    nodejs \
    npm \
    python3 \
    python3-pip

# Install Claude Code (assuming it's available via package manager)
# Replace with actual installation method
RUN npm install -g @anthropic/claude-code

# TypeScipt Support
RUN npm install -g typescript ts-node

# Install API dependencies
WORKDIR /app
COPY package.json .
RUN npm install

# Copy API server code
COPY . .

EXPOSE 3000
CMD ["ts-node", "server.ts"]
```