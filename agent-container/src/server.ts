import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { SessionManager } from './session-manager';
import { CreateSessionRequest, SendMessageRequest } from './types';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';

const app = new Hono();
const sessionManager = new SessionManager();

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Session endpoints
app.post('/sessions', async (c) => {
  try {
    const body = await c.req.json<CreateSessionRequest>().catch(() => ({}));
    const session = await sessionManager.createSession(body);
    return c.json(session, 201);
  } catch (error: any) {
    console.error('Error creating session:', error);
    return c.json({ error: error.message || 'Failed to create session' }, 500);
  }
});

app.get('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({
    ...session,
    isRunning: sessionManager.isSessionRunning(sessionId),
  });
});

app.get('/sessions', (c) => {
  const sessions = sessionManager.getAllSessions();
  return c.json(sessions);
});

app.delete('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const deleted = await sessionManager.deleteSession(sessionId);

  if (!deleted) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ success: true });
});

// Message endpoints
app.get('/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const messages = sessionManager.getMessages(sessionId);
  return c.json(messages);
});

app.post('/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    const body = await c.req.json<SendMessageRequest>();
    const content = typeof body.content === 'string' ? body.content : JSON.stringify(body.content);

    await sessionManager.sendMessage(sessionId, content);

    return c.json({ success: true }, 201);
  } catch (error: any) {
    console.error('Error sending message:', error);
    return c.json({ error: error.message || 'Failed to send message' }, 500);
  }
});

// File system endpoints
app.get('/files/*', async (c) => {
  const filePath = c.req.param('*') || '';
  const fullPath = path.join('/workspace', filePath);

  try {
    const stats = await fs.promises.stat(fullPath);

    if (stats.isDirectory()) {
      const files = await fs.promises.readdir(fullPath);
      const fileInfos = await Promise.all(
        files.map(async (file) => {
          const fileFullPath = path.join(fullPath, file);
          const fileStats = await fs.promises.stat(fileFullPath);
          return {
            name: file,
            path: path.join(filePath, file),
            type: fileStats.isDirectory() ? 'directory' : 'file',
            size: fileStats.isFile() ? fileStats.size : undefined,
            modifiedAt: fileStats.mtime,
          };
        })
      );
      return c.json(fileInfos);
    } else {
      return c.json({
        name: path.basename(filePath),
        path: filePath,
        type: 'file',
        size: stats.size,
        modifiedAt: stats.mtime,
      });
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return c.json({ error: 'File or directory not found' }, 404);
    }
    console.error('Error accessing file:', error);
    return c.json({ error: error.message || 'Failed to access file' }, 500);
  }
});

app.get('/files/*/content', async (c) => {
  const filePath = (c.req.param('*') || '').replace('/content', '');
  const fullPath = path.join('/workspace', filePath);

  try {
    const content = await fs.promises.readFile(fullPath, 'utf-8');
    return c.text(content);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return c.json({ error: 'File not found' }, 404);
    }
    console.error('Error reading file:', error);
    return c.json({ error: error.message || 'Failed to read file' }, 500);
  }
});

app.post('/files/*/upload', async (c) => {
  const filePath = (c.req.param('*') || '').replace('/upload', '');
  const fullPath = path.join('/workspace', filePath);

  try {
    const body = await c.req.text();
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, body);
    return c.json({ success: true, path: filePath });
  } catch (error: any) {
    console.error('Error uploading file:', error);
    return c.json({ error: error.message || 'Failed to upload file' }, 500);
  }
});

app.delete('/files/*', async (c) => {
  const filePath = c.req.param('*') || '';
  const fullPath = path.join('/workspace', filePath);

  try {
    const stats = await fs.promises.stat(fullPath);
    if (stats.isDirectory()) {
      await fs.promises.rm(fullPath, { recursive: true });
    } else {
      await fs.promises.unlink(fullPath);
    }
    return c.json({ success: true });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return c.json({ error: 'File or directory not found' }, 404);
    }
    console.error('Error deleting file:', error);
    return c.json({ error: error.message || 'Failed to delete file' }, 500);
  }
});

app.post('/files/*/mkdir', async (c) => {
  const dirPath = (c.req.param('*') || '').replace('/mkdir', '');
  const fullPath = path.join('/workspace', dirPath);

  try {
    await fs.promises.mkdir(fullPath, { recursive: true });
    return c.json({ success: true, path: dirPath });
  } catch (error: any) {
    console.error('Error creating directory:', error);
    return c.json({ error: error.message || 'Failed to create directory' }, 500);
  }
});

app.get('/files/tree', async (c) => {
  const depth = parseInt(c.req.query('depth') || '3');
  const startPath = c.req.query('path') || '';
  const fullPath = path.join('/workspace', startPath);

  try {
    const tree = await buildFileTree(fullPath, depth, 0);
    return c.json(tree);
  } catch (error: any) {
    console.error('Error building file tree:', error);
    return c.json({ error: error.message || 'Failed to build file tree' }, 500);
  }
});

async function buildFileTree(
  dirPath: string,
  maxDepth: number,
  currentDepth: number
): Promise<any> {
  if (currentDepth >= maxDepth) {
    return null;
  }

  try {
    const stats = await fs.promises.stat(dirPath);
    const name = path.basename(dirPath);
    const relativePath = path.relative('/workspace', dirPath);

    if (!stats.isDirectory()) {
      return {
        name,
        path: relativePath,
        type: 'file',
        size: stats.size,
      };
    }

    const files = await fs.promises.readdir(dirPath);
    const children = await Promise.all(
      files.map((file) =>
        buildFileTree(path.join(dirPath, file), maxDepth, currentDepth + 1)
      )
    );

    return {
      name: name || 'workspace',
      path: relativePath,
      type: 'directory',
      children: children.filter((child) => child !== null),
    };
  } catch (error) {
    return null;
  }
}

// Start the server
const port = parseInt(process.env.PORT || '3000');
const server = serve({
  fetch: app.fetch,
  port,
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade
server.on('upgrade', (request: http.IncomingMessage, socket: any, head: Buffer) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const pathname = url.pathname;

  // Check if this is a session stream endpoint
  const match = pathname.match(/^\/sessions\/([^/]+)\/stream$/);
  if (match) {
    const sessionId = match[1];

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      handleWebSocketConnection(ws, sessionId);
    });
  } else {
    socket.destroy();
  }
});

async function handleWebSocketConnection(ws: WebSocket, sessionId: string) {
  console.log(`WebSocket connection established for session ${sessionId}`);

  const session = await sessionManager.getSession(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    ws.close();
    return;
  }

  // Subscribe to session events (SDK messages)
  const unsubscribe = sessionManager.subscribe(sessionId, (message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });

  // Handle incoming messages
  ws.on('message', async (data: Buffer) => {
    try {
      const payload = JSON.parse(data.toString());
      const content = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content);

      await sessionManager.sendMessage(sessionId, content);
    } catch (error: any) {
      console.error('Error handling WebSocket message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message || 'Failed to process message',
      }));
    }
  });

  // Handle connection close
  ws.on('close', () => {
    console.log(`WebSocket connection closed for session ${sessionId}`);
    unsubscribe();
  });

  // Handle errors
  ws.on('error', (error: Error) => {
    console.error(`WebSocket error for session ${sessionId}:`, error);
    unsubscribe();
  });

  // Send initial connection success message
  ws.send(JSON.stringify({
    type: 'status',
    data: { message: 'Connected to session stream' },
    timestamp: new Date(),
  }));
}

console.log(`Server running on http://localhost:${port}`);
console.log('Available endpoints:');
console.log('  POST   /sessions');
console.log('  GET    /sessions/:id');
console.log('  GET    /sessions');
console.log('  DELETE /sessions/:id');
console.log('  GET    /sessions/:id/messages');
console.log('  POST   /sessions/:id/messages');
console.log('  WS     /sessions/:id/stream');
console.log('  GET    /files/*');
console.log('  GET    /files/*/content');
console.log('  POST   /files/*/upload');
console.log('  DELETE /files/*');
console.log('  POST   /files/*/mkdir');
console.log('  GET    /files/tree');
