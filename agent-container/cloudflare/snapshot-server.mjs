// Runs first in the agent's Cloudflare Container: serves snapshot.mjs on the port AgentDurableObject
// (src/cf/cloudflare-agent.ts) calls, for /workspace and the store at http://workspace.internal.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createSnapshot } from './snapshot.mjs'

const PORT = 8090

const snapshot = createSnapshot({
  workspace: '/workspace',
  store: 'http://workspace.internal',
  launch: () => spawn('gamut-start', [], { cwd: '/app', stdio: 'inherit' }),
  exit: (code) => process.exit(code),
})

http.createServer(snapshot.handle).listen(PORT)
snapshot.warm()

// As PID 1, Node ignores SIGTERM unless it handles it, and the container would never stop.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => snapshot.stop(signal))
