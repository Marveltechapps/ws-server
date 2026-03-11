const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envCandidates = [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', 'selorg-dashboard-backend-v1.1', '.env'),
];

const loadedEnvFiles = [];

for (const envPath of envCandidates) {
  if (!fs.existsSync(envPath)) {
    continue;
  }

  dotenv.config({ path: envPath, override: false });
  loadedEnvFiles.push(path.relative(__dirname, envPath));
}

const { createServer } = require('http');
const { Server: SocketServer } = require('socket.io');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { createCorsOriginHandler } = require('../selorg-dashboard-backend-v1.1/src/config/corsOrigins');

const WS_PORT = process.env.WS_PORT || 5050;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error(
    `[ws-server] FATAL: JWT_SECRET is not set. Checked env files: ${loadedEnvFiles.join(', ') || 'none'}. Exiting.`
  );
  process.exit(1);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer((_req, res) => {
  if (_req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'ws-server',
        connectedClients: io ? io.engine.clientsCount : 0,
        uptime: process.uptime(),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
// Path must match dashboard frontend (websocket.ts) and Picker/HHD apps
const io = new SocketServer(httpServer, {
  path: '/hhd-socket.io',
  cors: {
    origin: createCorsOriginHandler((origin) => {
      console.warn(`[ws-server] CORS blocked: ${origin}`);
    }),
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
});

// JWT authentication middleware
io.use((socket, next) => {
  const token =
    socket.handshake.auth.token ||
    socket.handshake.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.id || decoded.userId;
    socket.role = decoded.role || decoded.roleId;
    next();
  } catch (err) {
    console.warn(`[ws-server] Auth failed: ${err.message} (socket ${socket.id})`);
    next(new Error('Authentication error: Invalid token'));
  }
});

// ── Redis publisher ───────────────────────────────────────────────────────────
const pub = new Redis(REDIS_URL);
pub.on('error', (err) => console.error(`[ws-server] Redis publisher error: ${err.message}`));

// Connection handler
io.on('connection', (socket) => {
  console.log(
    `[ws-server] Client connected: ${socket.id} (user=${socket.userId}, role=${socket.role})`
  );

  if (socket.userId) socket.join(`user:${socket.userId}`);
  if (socket.role) socket.join(`role:${socket.role}`);

  // Darkstore connection: request initial snapshot via Redis relay
  if (socket.role === 'darkstore') {
    pub.publish('ws:request', JSON.stringify({
      event: 'get:live_orders',
      data: { storeId: '', status: 'all', limit: 100 },
      socketId: socket.id,
      userId: socket.userId,
      role: socket.role
    }));
  }

  socket.on('get:live_orders', (params) => {
    pub.publish('ws:request', JSON.stringify({
      event: 'get:live_orders',
      data: params,
      socketId: socket.id,
      userId: socket.userId,
      role: socket.role
    }));
  });

  socket.on('subscribe', (room) => {
    socket.join(room);
  });

  socket.on('unsubscribe', (room) => {
    socket.leave(room);
  });

  socket.on('disconnect', () => {
    console.log(`[ws-server] Client disconnected: ${socket.id}`);
  });
});

// ── Redis subscriber ──────────────────────────────────────────────────────────
const sub = new Redis(REDIS_URL);

sub.on('connect', () => {
  console.log(`[ws-server] Redis subscriber connected (${REDIS_URL})`);
});

sub.on('error', (err) => {
  console.error(`[ws-server] Redis subscriber error: ${err.message}`);
});

sub.subscribe('ws:role', 'ws:user', 'ws:room', 'ws:broadcast', 'ws:hhd', (err) => {
  if (err) {
    console.error(`[ws-server] Redis subscribe error: ${err.message}`);
  } else {
    console.log('[ws-server] Subscribed to Redis channels: ws:role, ws:user, ws:room, ws:broadcast, ws:hhd');
  }
});

sub.on('message', (channel, message) => {
  try {
    const payload = JSON.parse(message);
    const { target, event, data } = payload;

    switch (channel) {
      case 'ws:role':
        io.to(`role:${target}`).emit(event, data);
        break;
      case 'ws:user':
        io.to(`user:${target}`).emit(event, data);
        break;
      case 'ws:room':
        io.to(target).emit(event, data);
        break;
      case 'ws:broadcast':
        io.emit(event, data);
        break;
      case 'ws:hhd':
        // HHD events use the same room conventions
        if (payload.roomType === 'order') {
          io.to(`order:${target}`).emit(event, data);
        } else if (payload.roomType === 'user') {
          io.to(`user:${target}`).emit(event, data);
        } else {
          io.emit(event, data);
        }
        break;
      default:
        break;
    }
  } catch (err) {
    console.error(`[ws-server] Failed to process Redis message on ${channel}: ${err.message}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(WS_PORT, () => {
  console.log(`[ws-server] WebSocket server listening on port ${WS_PORT}`);
  console.log(`[ws-server] Health check: http://localhost:${WS_PORT}/health`);
});

process.on('unhandledRejection', (err) => {
  console.error(`[ws-server] Unhandled rejection: ${err.message}`);
});

process.on('uncaughtException', (err) => {
  console.error(`[ws-server] Uncaught exception: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[ws-server] SIGTERM received. Shutting down...');
  sub.quit();
  io.close();
  httpServer.close(() => process.exit(0));
});
