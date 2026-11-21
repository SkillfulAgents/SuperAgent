// Runs first in the agent's Cloudflare Container: serves cf-workspace-service.mjs on the port AgentDurableObject
// (src/cf/objects/cloudflare-agent.ts) calls, for /workspace and the store at http://workspace.internal.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createWorkspaceService } from './cf-workspace-service.mjs'

const PORT = 8090

const service = createWorkspaceService({
  workspace: '/workspace',
  store: 'http://workspace.internal',
  launch: () => spawn('gamut-start', [], { cwd: '/app', stdio: 'inherit' }),
  exit: (code) => process.exit(code),
})

http.createServer(service.handle).listen(PORT)
service.warm()

// As PID 1, Node ignores SIGTERM unless it handles it, and the container would never stop.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => service.stop(signal))
